"""Database paging, data representation, and driver compatibility regressions."""
from contextlib import closing
from decimal import Decimal
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from app.services import connector_database as db, connector_database_extra as extra
from app.services.connector_mysql_auth import CachingSha2Authentication
from test_connector_database_extra import spec, result, http_server


class DatabaseRegressions(unittest.TestCase):
    def test_document_writes_are_hidden_and_refused_outside_saved_scope(self):
        cases = [
            ("redis", {"REDIS_HOST": "localhost"}, "REDIS_INSERT_PREFIXES", "handoff:",
             "create_text", {"key": "other:demo", "text": "ok"}, "_redis_connection"),
            ("mongodb", {"MONGO_HOST": "localhost", "MONGO_DATABASE": "fixture"}, "MONGO_INSERT_COLLECTIONS",
             "notes", "insert_document", {"collection": "notes_archive", "document": {"value": 1}}, "_mongo_connection"),
        ]
        for kind, env, scope_key, scope, tool, args, connect in cases:
            for enabled, names in (("false", scope), ("true", " , "), ("true", scope)):
                with self.subTest(kind=kind, enabled=enabled, scope=names):
                    target = spec(kind, **env, ALLOW_WRITES=enabled, **{scope_key: names})
                    listed = {t["name"]: t for t in json.loads(db.execute(target, "list"))["tools"]}
                    self.assertEqual(tool in listed, enabled == "true" and names == scope)
                    if tool in listed:
                        self.assertIn(scope, listed[tool]["description"])
                        self.assertFalse(listed[tool]["annotations"]["readOnlyHint"])
                    with patch.object(extra, connect) as dial, self.assertRaisesRegex(ValueError, "未授权"):
                        result(target, tool, args)
                    dial.assert_not_called()
                    with self.assertRaisesRegex(ValueError, "只支持查询和新增"):
                        result(target, "delete_record", {})

    def test_redis_lost_ack_reads_original_key_without_a_second_set(self):
        from redis.exceptions import TimeoutError
        target = spec("redis", REDIS_HOST="localhost", REDIS_INSERT_PREFIXES="notes:", ALLOW_WRITES="true")
        with patch.object(extra, "_redis_connection") as connect:
            redis = connect.return_value.__enter__.return_value
            redis.set.side_effect = TimeoutError()
            redis.getrange.return_value = "备注".encode()
            with self.assertRaisesRegex(ValueError, "当前键的文本与请求一致"):
                result(target, "create_text", {"key": "notes:demo", "text": "备注"})
            redis.set.assert_called_once_with("notes:demo", "备注", nx=True, ex=86400)
            redis.getrange.assert_called_once()

    def test_mongo_lost_ack_reads_same_typed_id_without_a_second_insert(self):
        from pymongo.errors import AutoReconnect
        target = spec("mongodb", MONGO_HOST="localhost", MONGO_DATABASE="fixture",
                      MONGO_INSERT_COLLECTIONS="notes", ALLOW_WRITES="true")
        with patch.object(extra, "_mongo_connection") as connect:
            database = connect.return_value.__enter__.return_value["fixture"]
            database.list_collections.return_value.__enter__.side_effect = (
                lambda: iter([{"name": "notes", "type": "collection"}]))
            collection = database["notes"]
            collection.insert_one.side_effect = AutoReconnect()
            receipt = result(target, "insert_document", {"collection": "notes", "document": {"value": "偏热"}})
            collection.insert_one.assert_called_once()
            oid = collection.insert_one.call_args.args[0]["_id"]
            collection.find_one.assert_called_once_with({"_id": oid}, {"_id": 1})
            self.assertEqual(receipt, {"inserted": 1, "insertId": {"$oid": str(oid)}, "verifiedAfterTimeout": True})
            collection.insert_one.reset_mock()
            collection.find_one.side_effect = AutoReconnect()
            with self.assertRaisesRegex(ValueError, "结果待确认") as caught:
                result(target, "insert_document", {"collection": "notes", "document": {"value": "偏热"}})
            collection.insert_one.assert_called_once()
            self.assertIn(str(collection.insert_one.call_args.args[0]["_id"]), str(caught.exception))

    def test_postgres_insert_grant_is_scoped_to_schema_and_table(self):
        env = dict(PG_HOST="localhost", PG_DATABASE="fixture", PG_USER="fixture", PG_PASSWORD="fixture")
        for enabled, tables, schema in (("false", "city", "public"), ("true", "", "public"),
                                        ("true", "city", "private"), ("true", "private.city", "public")):
            target = spec("postgres", **env, ALLOW_WRITES=enabled, PG_INSERT_TABLES=tables)
            names = {t["name"] for t in json.loads(db.execute(target, "list"))["tools"]}
            self.assertEqual("insert_row" in names, enabled == "true" and bool(tables))
            with patch.object(db, "connect") as connect, self.assertRaisesRegex(ValueError, "未授权"):
                result(target, "insert_row", {"schema": schema, "table": "city", "values": {"name": "demo"}})
            connect.assert_not_called()

    def test_sqlite_inserts_follow_each_table_and_cannot_replace_or_modify_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.db"
            with closing(sqlite3.connect(path)) as conn:
                conn.executescript("""
                    CREATE TABLE city(id INTEGER PRIMARY KEY, name VARCHAR(6) NOT NULL, founded_on DATE);
                    CREATE TABLE product(id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE ON CONFLICT REPLACE,
                                         price DECIMAL(6,2) NOT NULL CHECK(price>=0), stock INTEGER DEFAULT 0);
                """)
            target = spec("sqlite", SQLITE_PATH=str(path), ALLOW_WRITES="true", SQLITE_INSERT_TABLES="city,product")

            def insert(table, **values):
                return result(target, "insert_row", {"table": table, "values": values})

            self.assertEqual(insert("city", name="青河", founded_on="2001-06-15")["insertId"], 1)
            self.assertEqual(insert("product", title="水杯", price="19.90")["insertId"], 1)
            for table, values, error in (
                    ("city", {"name": "too long"}, "name"), ("city", {"name": "a", "price": 1}, "price"),
                    ("city", {"name": "a", "founded_on": "2025-02-30"}, "founded_on"),
                    ("product", {"title": "马克杯", "price": "面议"}, "price"),
                    ("product", {"title": "水杯", "price": 2}, "约束"),
                    ("product", {"title": "a", "price": -1}, "约束"),
                    ("product", {"title": "a", "price": "1.234"}, "精度"),
                    ("product", {"title": "a"}, "price"),
                    ("city", {"name": "a", "id": 2}, "自动生成")):
                with self.subTest(values=values), self.assertRaisesRegex(ValueError, error):
                    insert(table, **values)
            for name in ("update_row", "delete_row"):
                with self.assertRaisesRegex(ValueError, "操作未执行"):
                    result(target, name, {"table": "city"})
            with closing(sqlite3.connect(path)) as conn:
                conn.executescript("""
                    ALTER TABLE city ADD COLUMN region TEXT NOT NULL DEFAULT 'north';
                    CREATE TRIGGER side_effect AFTER INSERT ON product BEGIN UPDATE city SET name='changed'; END;
                """)
            with self.assertRaises(ValueError):
                insert("product", title="a", price=1)
            insert("city", name="海城", region="east")
            self.assertEqual(result(target, "read_rows", {"table": "product"})["rows"], [[1, "水杯", 19.9, 0]])
            self.assertEqual(result(target, "read_rows", {"table": "city", "order_by": "id"})["rows"],
                             [[1, "青河", "2001-06-15", "north"], [2, "海城", None, "east"]])
            for switch, tables in (("false", "city"), ("true", ""), ("true", "product")):
                restricted = spec("sqlite", SQLITE_PATH=str(path), ALLOW_WRITES=switch, SQLITE_INSERT_TABLES=tables)
                with self.assertRaisesRegex(ValueError, "未授权"):
                    result(restricted, "insert_row", {"table": "city", "values": {"name": "demo"}})

    def test_mysql_insert_requires_both_connection_grants_even_on_direct_calls(self):
        from app.services.plugin_mcp_gateway import tool_risk
        env = dict(MYSQL_HOST="localhost", MYSQL_DATABASE="fixture", MYSQL_USER="reader", MYSQL_PASSWORD="fixture")
        for switch, tables in (("false", "items"), ("true", ""), ("true", "other"), ("true", "items")):
            target = spec("mysql", **env, ALLOW_WRITES=switch, MYSQL_INSERT_TABLES=tables)
            tools = {t["name"]: t["annotations"] for t in json.loads(db.execute(target, "list"))["tools"]}
            self.assertEqual("insert_row" in tools, switch == "true" and bool(tables))
            if "insert_row" in tools:
                self.assertFalse(tools["insert_row"]["readOnlyHint"])
                write = next(t for t in db.definition("mysql")["tools"] if t["name"] == "insert_row")
                self.assertEqual(tool_risk(write["name"], write["description"]), "medium")
            if switch != "true" or tables != "items":
                with patch.object(db, "connect") as connect, self.assertRaisesRegex(ValueError, "未授权"):
                    db.execute(target, "call", "insert_row", {"table": "items", "values": {"name": "demo"}})
                connect.assert_not_called()

    def test_insert_shape_follows_metadata_and_preserves_server_defaults(self):
        from app.services.connector_mysql_insert import insert_parameters
        columns = [
            ("id", "int", "NO", "int", None, 10, 0, None, "auto_increment"),
            ("name", "varchar", "NO", "varchar(4)", 4, None, None, None, ""),
            ("qty", "tinyint", "NO", "tinyint unsigned", None, 3, 0, "0", ""),
            ("price", "decimal", "YES", "decimal(3,2)", None, 3, 2, None, ""),
            ("day", "date", "YES", "date", None, None, None, None, ""),
            ("total", "int", "YES", "int", None, 10, 0, None, "STORED GENERATED"),
        ]
        self.assertEqual(insert_parameters(columns, {"name": "演示", "price": "1.20"}),
                         {"name": "演示", "price": Decimal("1.20")})
        for invalid in ({"id": 1}, {"total": None}, {"qty": -1}, {"qty": 256}, {"qty": True},
                        {"price": "10.00"}, {"price": "1.234"}, {"day": "2026-02-30"},
                        {"unknown": ""}, {"name": "12345"}, {"name": None}):
            with self.subTest(invalid=invalid), self.assertRaises(extra.InputError):
                insert_parameters(columns, {"name": "ok", **invalid})
        with self.assertRaisesRegex(extra.InputError, "name"):
            insert_parameters(columns, {"qty": 0})

    def test_bound_sql_pages_and_sort_are_validated_without_sql_fragments(self):
        for kind in ("postgres", "mysql"):
            sql, params, limit = db.statement(kind, "read_rows", {"table": "sample", "limit": 2, "offset": 2, "order_by": "id"})
            self.assertIn("ORDER BY", sql)
            self.assertTrue(sql.endswith("LIMIT %s OFFSET %s"))
            self.assertEqual(params, (2, 2))
            self.assertEqual(limit, 2)
            for args in ({"table": "sample", "offset": 1}, {"table": "sample", "offset": True},
                         {"table": "sample", "offset": 10001}, {"table": "sample", "order_by": "id DESC; DELETE"}):
                with self.subTest(kind=kind, args=args), self.assertRaises(ValueError):
                    db.statement(kind, "read_rows", args)

    def test_sqlite_pages_do_not_repeat_first_page_and_leave_bytes_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.db"
            with closing(sqlite3.connect(path)) as conn, conn:
                conn.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, title TEXT)")
                conn.executemany("INSERT INTO sample VALUES (?,?)", [(n, "row" + str(n)) for n in range(1, 5)])
                conn.execute("CREATE TABLE second (id INTEGER)")
            before = path.read_bytes()
            target = spec("sqlite", SQLITE_PATH=str(path))
            first = result(target, "read_rows", {"table": "sample", "limit": 2, "order_by": "id"})
            second = result(target, "read_rows", {"table": "sample", "limit": 2, "offset": 2, "order_by": "id"})
            self.assertEqual([r[0] for r in first["rows"] + second["rows"]], [1, 2, 3, 4])
            self.assertEqual(second["offset"], 2)
            self.assertEqual(result(target, "list_tables", {"limit": 1, "offset": 1})["rows"], [["second"]])
            with self.assertRaisesRegex(ValueError, "排序字段"):
                result(target, "read_rows", {"table": "sample", "offset": 1})
            self.assertEqual(before, path.read_bytes())

    def test_clickhouse_pages_reach_server_without_untrusted_sql(self):
        with http_server(lambda _: (200, {}, {"meta": [{"name": "id"}], "data": [{"id": 3}]})) as (url, calls):
            target = spec("clickhouse", CH_URL=url, CH_DATABASE="fixture", CH_PASSWORD="fixture")
            rows = result(target, "read_rows", {"table": "sample", "limit": 1, "offset": 2, "order_by": "id"})
            self.assertEqual(rows["rows"], [{"id": 3}])
            self.assertIn(b"ORDER BY `id` LIMIT 1 OFFSET 2 FORMAT JSON", calls[-1][3])
            with self.assertRaisesRegex(ValueError, "排序字段"):
                result(target, "read_rows", {"table": "sample", "offset": 1})
            self.assertEqual(len(calls), 1)

    def test_sql_values_preserve_binary_and_decimal_precision_as_valid_json(self):
        for kind in ("postgres", "mysql"):
            connection = MagicMock()
            cursor = connection.cursor.return_value
            cursor.description = [("binary",), ("amount",)]
            cursor.fetchmany.return_value = [(memoryview(b"\xff\x01"), Decimal("12345678901234567890.123456789"))]
            with patch.object(db, "config", return_value=(kind, {})), patch.object(db, "connect", return_value=connection):
                rows = json.loads(json.loads(db.execute({}, "call", "read_rows", {"table": "sample"}))["content"][0]["text"])
            self.assertEqual(rows["rows"][0], [{"encoding": "base64", "value": "/wE="}, "12345678901234567890.123456789"])
            connection.close.assert_called_once()

    def test_health_requires_actual_probe_value_and_not_just_fetch_success(self):
        for row in (None, (0,), (2,)):
            connection = MagicMock()
            connection.cursor.return_value.fetchone.return_value = row
            with patch.object(db, "config", return_value=("mysql", {})), patch.object(db, "connect", return_value=connection):
                self.assertFalse(json.loads(db.execute({}, "health"))["ok"])
            connection.rollback.assert_called_once()
            connection.close.assert_called_once()

    def test_driver_handler_uses_official_auth_and_preserves_failure(self):
        connection, packet = object(), object()
        for value in (None, object()):
            with patch("pymysql._auth.caching_sha2_password_auth", return_value=value) as authenticate:
                self.assertIs(CachingSha2Authentication(connection).authenticate(packet), value)
                authenticate.assert_called_once_with(connection, packet)
        with patch("pymysql._auth.caching_sha2_password_auth", side_effect=RuntimeError("fixture-rejection")):
            with self.assertRaisesRegex(RuntimeError, "fixture-rejection"):
                CachingSha2Authentication(connection).authenticate(packet)

    def test_mysql_public_hook_is_per_connection_and_tls_not_downgraded(self):
        values = {"MYSQL_HOST": "db.example.com", "MYSQL_DATABASE": "fixture", "MYSQL_USER": "reader", "MYSQL_PASSWORD": "fixture"}
        with patch("pymysql.connect") as connect:
            db.connect("mysql", values, 3)
        options = connect.call_args.kwargs
        self.assertFalse(options["ssl_disabled"])
        self.assertTrue(options["ssl"].check_hostname)
        self.assertIs(options["auth_plugin_map"]["caching_sha2_password"], CachingSha2Authentication)
        self.assertFalse(options["local_infile"])

    def test_sql_remote_tls_requires_explicit_opt_out(self):
        for kind, prefix, driver, option in (("postgres", "PG", "pg8000.dbapi.connect", "ssl_context"),
                                             ("mysql", "MYSQL", "pymysql.connect", "ssl")):
            env = {prefix + "_HOST": "db.example.com", prefix + "_DATABASE": "fixture",
                   prefix + "_USER": "reader", prefix + "_PASSWORD": "fixture"}
            for setting in ({}, {"DISABLE_TLS": ""}, {"DISABLE_TLS": "false"}, {"DISABLE_TLS": "true"}):
                with self.subTest(kind=kind, setting=setting), patch(driver) as connect:
                    _, values = db.config(spec(kind, **env, **setting))
                    db.connect(kind, values, 3)
                    options = connect.call_args.kwargs
                    if setting.get("DISABLE_TLS") == "true":
                        if kind == "postgres":
                            self.assertIs(options[option], False)
                        else:
                            self.assertIsNone(options[option])
                            self.assertTrue(options["ssl_disabled"])
                    else:
                        self.assertTrue(options[option].check_hostname)

    def test_mongo_remote_tls_opt_out_applies_to_direct_and_srv_connections(self):
        for srv in ("true", "false"):
            for setting in ("true", "false"):
                with self.subTest(srv=srv, setting=setting), patch("pymongo.MongoClient") as client:
                    _, values = db.config(spec("mongodb", MONGO_HOST="mongo.example.com", MONGO_DATABASE="fixture",
                                               MONGO_SRV=srv, DISABLE_TLS=setting))
                    with extra._mongo_connection(values, 3):
                        self.assertEqual(client.call_args.kwargs["tls"], setting == "false")


if __name__ == "__main__":
    unittest.main()
