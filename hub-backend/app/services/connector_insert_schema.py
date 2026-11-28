"""Validate a single row against metadata obtained inside the write transaction."""
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
import math
import re

from .connector_database_extra import InputError

INSERT_LIST = {"mysql": "MYSQL_INSERT_TABLES", "postgres": "PG_INSERT_TABLES", "sqlite": "SQLITE_INSERT_TABLES"}


def insert_tables(kind, config):
    if config.get("ALLOW_WRITES") != "true":
        return set()
    names = {item.strip() for item in config.get(INSERT_LIST.get(kind), "").split(",") if item.strip()}
    if kind == "postgres":
        return {name if "." in name else "public." + name for name in names}
    return names


def authorize(kind, config, args):
    table = args["table"]
    target = args.get("schema", "public") + "." + table if kind == "postgres" else table
    if target not in insert_tables(kind, config):
        raise InputError("此连接未授权向该表新增数据")
    if not 1 <= len(args["values"]) <= 100:
        raise InputError("新增一行须提供 1 至 100 个字段")


@dataclass(frozen=True)
class Column:
    name: str
    kind: str
    nullable: bool
    default: bool
    generated: bool = False
    length: int | None = None
    bits: int | None = None
    unsigned: bool = False
    precision: int | None = None
    scale: int | None = None
    min_year: int = 1

    def value(self, value):
        if value is None:
            if self.nullable:
                return None
            raise InputError(f"{self.name} 不能为空")
        if self.kind == "text":
            if isinstance(value, str) and (self.length is None or len(value) <= self.length):
                return value
            limit = f"（最多 {self.length} 个字符）" if self.length is not None else ""
            raise InputError(f"{self.name} 必须是文本{limit}")
        if self.kind == "integer":
            high = 2 ** (self.bits if self.unsigned else self.bits - 1) - 1
            low = 0 if self.unsigned else -high - 1
            if type(value) is int and low <= value <= high:
                return value
            raise InputError(f"{self.name} 必须是 {low} 到 {high} 之间的整数")
        if self.kind == "decimal":
            if not re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?", str(value)):
                raise InputError(f"{self.name} 必须填写数字")
            number = Decimal(str(value))
            if self.unsigned and number < 0:
                raise InputError(f"{self.name} 不能小于零")
            if self.precision is not None and self.scale is not None:
                if self.scale < 0:
                    places_ok = int(number) == number and int(number) % (10 ** -self.scale) == 0
                else:
                    places_ok = number.as_tuple().exponent >= -self.scale
                if not places_ok or (number and number.adjusted() >= self.precision - self.scale):
                    raise InputError(f"{self.name} 必须符合 decimal({self.precision},{self.scale}) 的精度和取值范围")
            return number
        if self.kind == "date":
            if isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
                try:
                    day = date.fromisoformat(value)
                    if day.year >= self.min_year:
                        return day
                except ValueError:
                    pass
            raise InputError(f"{self.name} 必须是有效的 YYYY-MM-DD 日期")
        if self.kind == "boolean" and type(value) is bool:
            return value
        if self.kind == "real" and type(value) in (int, float) and abs(value) <= 1.7976931348623157e308 and math.isfinite(value):
            return value
        raise InputError(f"{self.name} 的值或字段类型 {self.kind} 不支持新增")


def validated_values(columns, values):
    unknown = sorted(set(values) - {column.name for column in columns})
    if unknown:
        raise InputError("表中无此字段：" + ", ".join(unknown)[:200])
    result = {}
    for column in columns:
        if column.name in values:
            if column.generated:
                raise InputError(f"{column.name} 由数据库自动生成，请省略")
            result[column.name] = column.value(values[column.name])
        elif not (column.nullable or column.default or column.generated):
            raise InputError(f"缺少必填字段：{column.name}")
    return result
