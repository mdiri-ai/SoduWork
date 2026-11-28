"""Single-record Redis and MongoDB writes on a scoped database connection."""
import json

from .connector_database_extra import InputError


def create_text(conn, key, text, ttl):
    from redis.exceptions import AuthenticationError, ConnectionError, ResponseError, TimeoutError

    try:
        created = conn.set(key, text, nx=True, ex=ttl)
    except AuthenticationError:
        raise InputError("Redis 账号认证失败，请检查连接凭据") from None
    except ResponseError:
        raise InputError("Redis 拒绝新增，请检查账号在该前缀的写入权限和实例写入状态") from None
    except (ConnectionError, TimeoutError):
        try:
            current = conn.getrange(key, 0, len(text.encode("utf-8")))
            matches = current == text.encode("utf-8")
        except Exception:
            matches = False
        message = "当前键的文本与请求一致，无法确认写入来源" if matches else "未核实写入结果"
        raise InputError(f"Redis 新增结果待确认。{message}。请查询原键 {key}，不要重复新增") from None
    if not created:
        raise InputError("这条记录已经存在，原内容和到期时间均已保留")
    return {"key": key, "created": True, "ttl_seconds": ttl}


def validation_hint(detail, path=""):
    """Use schema field names and expected types only. Never echo rejected documents."""
    if not isinstance(detail, dict):
        return ""
    field = detail.get("propertyName")
    if isinstance(field, str):
        path = f"{path}.{field}" if path else field
    missing = detail.get("missingProperties")
    if isinstance(missing, list) and missing:
        return "缺少必填字段 " + "、".join(str(name)[:100] for name in missing[:5])
    rule = detail.get("operatorName")
    expected = detail.get("specifiedAs", {}).get(rule) if rule in {"bsonType", "type"} else None
    if path and expected:
        labels = {"int": "整数", "long": "长整数", "number": "数字", "double": "浮点数", "decimal": "定点数",
                  "string": "文本", "bool": "布尔值", "date": "日期", "array": "数组", "object": "对象"}
        types = expected if isinstance(expected, list) else [expected]
        return f"字段 {path[:160]} 需要" + "或".join(labels.get(t, t) for t in types if isinstance(t, str))
    for group in ("schemaRulesNotSatisfied", "propertiesNotSatisfied", "details", "clausesNotSatisfied",
                  "schemasNotSatisfied", "itemsNotSatisfied"):
        nodes = detail.get(group, [])
        for child in nodes if isinstance(nodes, list) else [nodes]:
            hint = validation_hint(child, path)
            if hint:
                return hint
    return f"字段 {path[:160]} 不符合集合规则" if path else ""


def insert_document(db, name, document):
    from bson import ObjectId, json_util
    from bson.errors import InvalidDocument
    from pymongo.errors import (ConnectionFailure, DuplicateKeyError, OperationFailure,
                                PyMongoError, WriteConcernError)

    if not document:
        raise InputError("请至少填写一个文档字段")
    try:
        with db.list_collections(filter={"name": name}, nameOnly=True, authorizedCollections=True) as cursor:
            target = next(cursor, None)
    except PyMongoError:
        raise InputError("无法核实目标集合，请检查连接和账号查看集合的权限") from None
    if not target or target.get("type") != "collection":
        raise InputError("找不到可新增的普通集合，请检查集合名称和账号权限")

    record = dict(document)
    generated_id = "_id" not in record
    if generated_id:
        record["_id"] = ObjectId()
    identifier = json.loads(json_util.dumps(record["_id"]))
    collection = db[name]
    try:
        result = collection.insert_one(record)
        if result.acknowledged:
            return {"inserted": 1, "insertId": identifier}
    except DuplicateKeyError:
        raise InputError("记录编号或唯一字段已经存在，这条记录未新增") from None
    except (ConnectionFailure, WriteConcernError):
        pass  # A lost acknowledgment may follow a successful insert.
    except OperationFailure as exc:
        if exc.code == 121:
            info = (exc.details or {}).get("errInfo", {}).get("details", {})
            reason = validation_hint(info) or "文档不符合目标集合的校验规则"
            raise InputError(reason + "，这条记录未新增") from None
        if exc.code in {13, 18}:
            raise InputError("数据库账号没有向该集合新增的权限或认证失败") from None
        if not exc.timeout:
            raise InputError(f"MongoDB 拒绝新增（错误码 {exc.code}），这条记录未新增") from None
    except (InvalidDocument, OverflowError):
        raise InputError("字段值无法保存为 BSON，请检查字段名称和数值范围") from None

    try:
        found = collection.find_one({"_id": record["_id"]}, {"_id": 1}) is not None
    except PyMongoError:
        found = False
    if generated_id and found:
        return {"inserted": 1, "insertId": identifier, "verifiedAfterTimeout": True}
    message = "已查到该编号" if found else "尚未查到或无法核实该编号"
    raise InputError(f"MongoDB 新增结果待确认。{message}，请按原编号 "
                     + json.dumps(identifier, ensure_ascii=False) + " 核对，不要重复新增")
