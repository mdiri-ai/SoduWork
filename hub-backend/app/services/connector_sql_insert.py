"""Schema-checked inserts into explicitly authorized PostgreSQL and SQLite tables."""
from contextlib import closing
from datetime import date
from decimal import Decimal
import json
import re
import sqlite3

from .connector_database_extra import InputError, _sqlite_connection
from .connector_insert_schema import Column, validated_values


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def postgres_insert(conn, args, timeout):
    schema, table = args.get("schema", "public"), args["table"]
    target = quoted(schema) + "." + quoted(table)
    with closing(conn.cursor()) as cur:
        cur.execute("SET LOCAL search_path TO pg_catalog")
        cur.execute(f"SET LOCAL statement_timeout = {int(timeout) * 1000}")
        # Take INSERT's lock before reading metadata so DDL cannot attach a trigger in between.
        cur.execute(f"LOCK TABLE ONLY {target} IN ROW EXCLUSIVE MODE")
        cur.execute("SELECT c.relkind, EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid "
                    "AND NOT t.tgisinternal AND (t.tgtype::integer & 4) <> 0 AND t.tgenabled <> 'D'), "
                    "EXISTS (SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid AND r.ev_type='3' "
                    "AND r.ev_enabled <> 'D') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                    "WHERE n.nspname=%s AND c.relname=%s", (schema, table))
        relation = cur.fetchone()
        if not relation or relation[0] != "r":
            raise InputError("仅支持向已授权的普通 PostgreSQL 表新增")
        if relation[1] or relation[2]:
            raise InputError("该表有自定义新增触发器或重写规则，无法保证只新增目标行")
        cur.execute("SELECT column_name, data_type, is_nullable, column_default, is_identity, is_generated, "
                    "character_maximum_length, numeric_precision, numeric_scale FROM information_schema.columns "
                    "WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position", (schema, table))
        columns, ids = [], []
        for name, kind, nullable, default, identity, generated, length, precision, scale in cur.fetchall():
            auto = identity == "YES" or (default or "").startswith("nextval(")
            if auto:
                ids.append(name)
            bits = {"smallint": 16, "integer": 32, "bigint": 64}.get(kind)
            normalized = {"character varying": "text", "character": "text", "numeric": "decimal",
                          "double precision": "real"}.get(kind, kind)
            columns.append(Column(name, "integer" if bits else normalized, nullable == "YES", default is not None,
                                  auto or generated == "ALWAYS", length, bits, precision=precision, scale=scale))
        values = validated_values(columns, args["values"])
        fields = ", ".join(quoted(name) for name in values)
        placeholders = ", ".join(["%s"] * len(values))
        returning = quoted(ids[0]) if len(ids) == 1 else "NULL"
        cur.execute(f"INSERT INTO {target} ({fields}) VALUES ({placeholders}) RETURNING {returning}", tuple(values.values()))
        row = cur.fetchone()
        if row is None or cur.fetchone() is not None:
            raise InputError("数据库未确认恰好新增一行")
        return row[0]


def sqlite_column(row, auto, without_rowid):
    _, name, declaration, required, default, pk, hidden = row
    kind = declaration.strip().lower()
    match = re.fullmatch(r"(varchar|char|nvarchar|character varying|numeric|decimal)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?", kind)
    length = precision = scale = None
    if match:
        typename, first, second = match.groups()
        if typename in {"numeric", "decimal"}:
            kind = "decimal"
            precision = int(first) if first else None
            scale = int(second or 0) if first else None
        elif not second:
            kind, length = "text", int(first) if first else None
    elif kind in {"int", "integer", "bigint", "smallint", "tinyint"}:
        kind = "integer"
    elif kind in {"float", "double", "double precision"}:
        kind = "real"
    elif kind == "bool":
        kind = "boolean"
    return Column(name, kind, not (required or (pk and without_rowid)), default is not None,
                  auto or hidden != 0, length, bits=64, precision=precision, scale=scale)


def sqlite_insert(conn, args):
    table = args["table"]
    conn.execute("BEGIN IMMEDIATE")
    info = conn.execute("SELECT type,wr FROM pragma_table_list WHERE schema='main' AND name=?", (table,)).fetchone()
    if not info or info[0] != "table" or table.lower().startswith("sqlite_"):
        raise InputError("仅支持向已授权的普通 SQLite 表新增")
    rows = conn.execute('SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?,\'main\')',
                        (table,)).fetchall()
    # INTEGER PRIMARY KEY aliases rowid except on WITHOUT ROWID tables or indexed primary keys (e.g. DESC).
    indexed_pk = conn.execute("SELECT 1 FROM pragma_index_list(?) WHERE origin='pk'", (table,)).fetchone()
    columns = [sqlite_column(row, not info[1] and not indexed_pk and row[5] == 1
                             and row[2].upper() == "INTEGER", info[1]) for row in rows]
    values = validated_values(columns, args["values"])
    for name, val in values.items():
        if isinstance(val, Decimal):
            stored = conn.execute("SELECT CAST(? AS NUMERIC)", (str(val),)).fetchone()[0]
            if Decimal(str(stored)) != val:
                raise InputError(f"{name} 超出 SQLite 可精确保存的数值范围")
            values[name] = str(val)
        elif isinstance(val, date):
            values[name] = val.isoformat()

    def only_insert(action, resource, field, database, source):
        if action in {sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE} or (
                action == sqlite3.SQLITE_INSERT and (database != "main" or resource != table or source)):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    conn.set_authorizer(only_insert)
    fields = ", ".join(quoted(name) for name in values)
    marks = ", ".join(["?"] * len(values))
    cur = conn.execute(f"INSERT OR ABORT INTO main.{quoted(table)} ({fields}) VALUES ({marks})", tuple(values.values()))
    if cur.rowcount != 1:
        raise InputError("数据库未确认恰好新增一行")
    has_rowid_key = any(col.generated and row[6] == 0 for col, row in zip(columns, rows))
    return cur.lastrowid if has_rowid_key else None


def insert_row(kind, config, args, timeout):
    from .connector_database import connect
    committing = False
    try:
        manager = (_sqlite_connection(config, timeout, writable=True) if kind == "sqlite"
                   else closing(connect("postgres", config, timeout)))
        with manager as conn:
            identifier = sqlite_insert(conn, args) if kind == "sqlite" else postgres_insert(conn, args, timeout)
            committing = True
            conn.commit()
            data = {"table": args["table"], "inserted": 1, "insertId": identifier}
            return json.dumps({"content": [{"type": "text", "text": json.dumps(data)}], "isError": False})
    except InputError:
        raise
    except Exception as exc:
        detail = exc.args[0] if exc.args and isinstance(exc.args[0], dict) else {}
        if isinstance(exc, sqlite3.IntegrityError) or str(detail.get("C", "")).startswith("23"):
            raise InputError("新增失败：记录不符合表的必填、唯一键、外键或 CHECK 约束") from None
        if committing:
            raise InputError("未收到提交确认，请先查表核实再决定是否重试") from None
        raise InputError("新增失败，请检查目标表、写入权限和数据库约束") from None
