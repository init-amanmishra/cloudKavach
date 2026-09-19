"""DynamoDB access. One table: a connection and its scans share a partition key.

    pk = CONN#<connection id>   sk = META          -> the connection
    pk = CONN#<connection id>   sk = SCAN#<scan id> -> one scan and its report

Items carry an `expires_at` TTL so old scans and abandoned connections delete themselves.
"""
import json
import os
import time
import uuid

import boto3

_CONNECTION_TTL_DAYS = 30
_SCAN_TTL_DAYS = 7
_table_ref = None


def _table():
    global _table_ref
    if _table_ref is None:
        _table_ref = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _table_ref


def _pk(connection_id):
    return f"CONN#{connection_id}"


def _expires_in(days):
    return int(time.time()) + days * 86400


def create_connection(connection_id, external_id):
    _table().put_item(Item={
        "pk": _pk(connection_id),
        "sk": "META",
        "external_id": external_id,
        "status": "pending",
        "created_at": int(time.time()),
        "expires_at": _expires_in(_CONNECTION_TTL_DAYS),
    })


def get_connection(connection_id):
    return _table().get_item(Key={"pk": _pk(connection_id), "sk": "META"}).get("Item")


def mark_connected(connection_id, role_arn, account_id):
    _table().update_item(
        Key={"pk": _pk(connection_id), "sk": "META"},
        UpdateExpression="SET #role = :role, #account = :account, #status = :status",
        ExpressionAttributeNames={"#role": "role_arn", "#account": "account_id", "#status": "status"},
        ExpressionAttributeValues={":role": role_arn, ":account": account_id, ":status": "connected"},
    )


def new_scan(connection_id):
    scan_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"  # sorts by time
    _table().put_item(Item={
        "pk": _pk(connection_id),
        "sk": f"SCAN#{scan_id}",
        "status": "running",
        "started_at": int(time.time()),
        "expires_at": _expires_in(_SCAN_TTL_DAYS),
    })
    return scan_id


def finish_scan(connection_id, scan_id, report):
    # The report is stored as a JSON string: DynamoDB rejects Python floats, and the
    # API only ever reads the report back whole.
    _table().update_item(
        Key={"pk": _pk(connection_id), "sk": f"SCAN#{scan_id}"},
        UpdateExpression="SET #status = :status, #finished = :finished, #report = :report",
        ExpressionAttributeNames={"#status": "status", "#finished": "finished_at", "#report": "report"},
        ExpressionAttributeValues={":status": "done", ":finished": int(time.time()), ":report": json.dumps(report)},
    )


def fail_scan(connection_id, scan_id, message):
    _table().update_item(
        Key={"pk": _pk(connection_id), "sk": f"SCAN#{scan_id}"},
        UpdateExpression="SET #status = :status, #finished = :finished, #error = :error",
        ExpressionAttributeNames={"#status": "status", "#finished": "finished_at", "#error": "error"},
        ExpressionAttributeValues={":status": "failed", ":finished": int(time.time()), ":error": message},
    )


def get_scan(connection_id, scan_id):
    item = _table().get_item(Key={"pk": _pk(connection_id), "sk": f"SCAN#{scan_id}"}).get("Item")
    if item and "report" in item:
        item["report"] = json.loads(item["report"])
    return item
