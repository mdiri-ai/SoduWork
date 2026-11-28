"""Single-row inserts validated against the current MySQL table definition."""
from contextlib import suppress
import json

from .connector_database_extra import InputError
from .connector_insert_schema import Column, validated_values

COLUMN_FIELDS = ("column_name, data_type, is_nullable, column_type, character_maximum_length, "
                 "numeric_precision, numeric_scale, column_default, extra")
INTEGER_BITS = {"tinyint": 8, "smallint": 16, "mediumint": 24, "int": 32, "bigint": 64}


def insert_parameters(columns, values):
    schema = []
    for name, kind, nullable, column_type, length, precision, scale, default, extra in columns:
        bits = INTEGER_BITS.get(kind)
        if bits:
            kind = "integer"
        elif kind in {"char", "varchar", "tinytext", "text", "mediumtext", "longtext"}:
            kind = "text"
        generated = any(flag in extra.lower() for flag in ("auto_increment", "stored generated", "virtual generated"))
        schema.append(Column(name, kind, nullable == "YES", default is not None, generated,
                             length=length, bits=bits, unsigned="unsigned" in column_type.lower().split(),
                             precision=precision, scale=scale, min_year=1000))
    return validated_values(schema, values)


def insert_row(config, args, timeout):
    from .connector_database import connect

    table, values = args["table"], args["values"]
    connection = None
    committing = False
    try:
        connection = connect("mysql", config, timeout)
        with connection.cursor() as cursor:
            cursor.execute("SET SESSION lock_wait_timeout = %s", (timeout,))
            cursor.execute("SET SESSION innodb_lock_wait_timeout = %s", (timeout,))
            cursor.execute("START TRANSACTION READ WRITE")
            # Hold the table's metadata lock until commit so concurrent DDL cannot
            # replace the definition between validation and insertion.
            cursor.execute(f"SELECT * FROM `{table}` LIMIT 0")
            cursor.execute("SELECT engine FROM information_schema.tables WHERE table_schema=CAST(DATABASE() AS BINARY) "
                           "AND table_name=CAST(%s AS BINARY) AND table_type='BASE TABLE'", (table,))
            if cursor.fetchone() != ("InnoDB",):
                raise InputError("只能向当前库中已授权的 InnoDB 基础表新增数据")
            cursor.execute("SELECT " + COLUMN_FIELDS + " FROM information_schema.columns "
                           "WHERE table_schema=CAST(DATABASE() AS BINARY) AND table_name=CAST(%s AS BINARY) "
                           "ORDER BY ordinal_position", (table,))
            params = insert_parameters(cursor.fetchall(), values)
            # Only validated metadata names are interpolated. PyMySQL uses % formatting.
            fields = ", ".join("`" + name.replace("`", "``").replace("%", "%%") + "`" for name in params)
            placeholders = ", ".join(["%s"] * len(params))
            cursor.execute(f"INSERT INTO `{table}` ({fields}) VALUES ({placeholders})", tuple(params.values()))
            result = {"table": table, "inserted": cursor.rowcount, "insertId": cursor.lastrowid or None}
            cursor.execute("SHOW COUNT(*) WARNINGS")
            if cursor.fetchone()[0]:
                raise InputError("数据库对字段值发出警告，已取消新增，请检查长度、精度或字符集")
        committing = True
        connection.commit()
        return json.dumps({"content": [{"type": "text", "text": json.dumps(result)}], "isError": False})
    except InputError:
        raise
    except Exception as exc:
        if committing:
            raise InputError("未收到提交确认，请先查表核实再决定是否重试") from None
        code = exc.args[0] if exc.args else None
        if code in (1062, 1452, 3819):
            raise InputError("新增失败：记录不符合唯一键、外键或 CHECK 约束") from None
        raise InputError("新增失败，请检查目标表、数据库连接及账号的 SELECT 和 INSERT 权限") from None
    finally:
        if connection is not None:
            with suppress(Exception):
                connection.rollback()
            with suppress(Exception):
                connection.close()
