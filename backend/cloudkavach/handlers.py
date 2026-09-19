"""Lambda entry points: `api` behind API Gateway (HTTP API, payload v2.0) and the async `worker`."""
import base64
import hmac
import json
import os
import re
import secrets
import traceback
import urllib.parse
import uuid
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

from . import cleanup, explain, scanner, store

ROLE_ARN = re.compile(r"^arn:aws:iam::(\d{12}):role/CloudKavachAccess$")
CLEANUP_ROLE = "CloudKavachCleanup"  # separate, opt-in role: the scan role can never change anything
_lambda = None


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def log(event, **fields):
    print(json.dumps({"event": event, **fields}, default=str))


def _json_default(value):
    if isinstance(value, Decimal):  # DynamoDB returns every number as Decimal
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Cannot serialise {type(value).__name__}")


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body, default=_json_default),
    }


def _body(event):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HttpError(400, "The request body must be JSON.")
    if not isinstance(data, dict):
        raise HttpError(400, "The request body must be a JSON object.")
    return data


def _lambda_client():
    global _lambda
    if _lambda is None:
        _lambda = boto3.client("lambda")
    return _lambda


def _authorized_connection(event):
    """Every call after creating a connection must present its secret key (the ExternalId)."""
    connection_id = event["pathParameters"]["cid"]
    connection = store.get_connection(connection_id)
    key = (event.get("headers") or {}).get("x-kavach-key", "")
    if not connection or not hmac.compare_digest(key.encode(), connection["external_id"].encode()):
        raise HttpError(404, "Connection not found.")  # same answer either way, so ids can't be probed
    return connection_id, connection


def _stored_finding(connection_id, body):
    """Look the finding up in our own scan record: never trust resource details sent by the browser."""
    scan = store.get_scan(connection_id, str(body.get("scanId", "")))
    if not scan or scan.get("status") != "done":
        raise HttpError(404, "Scan not found or not finished yet.")
    for finding in scan["report"]["findings"]:
        if finding["id"] == body.get("findingId") and finding["region"] == body.get("region"):
            return finding
    raise HttpError(404, "That resource isn't in this scan.")


def create_connection(event, context):
    connection_id = uuid.uuid4().hex
    external_id = secrets.token_urlsafe(24)
    store.create_connection(connection_id, external_id)
    our_account = context.invoked_function_arn.split(":")[4]
    query = urllib.parse.urlencode({
        "templateURL": os.environ["TEMPLATE_URL"],
        "stackName": "CloudKavachAccess",
        "param_ExternalId": external_id,
        "param_KavachAccountId": our_account,
    })
    # IAM roles are global, so the stack's region doesn't matter; matching the template bucket's keeps it simple.
    region = os.environ.get("STACK_REGION", "us-east-1")
    launch_url = f"https://console.aws.amazon.com/cloudformation/home?region={region}#/stacks/quickcreate?{query}"
    return 201, {"connectionId": connection_id, "key": external_id, "launchUrl": launch_url}


def verify_connection(event, context):
    connection_id, connection = _authorized_connection(event)
    role_arn = str(_body(event).get("roleArn", "")).strip()
    match = ROLE_ARN.match(role_arn)
    if not match:
        raise HttpError(400, "Paste the RoleArn from the stack's Outputs tab. It ends in role/CloudKavachAccess.")
    try:
        scanner.session_for(role_arn, connection["external_id"]).client("sts").get_caller_identity()
    except ClientError:
        raise HttpError(400, "CloudKavach can't use that role yet. Wait until the stack shows CREATE_COMPLETE, then try again. "
                             "If the stack is from an earlier connection, delete it and create it again from this page.")
    store.mark_connected(connection_id, role_arn, match.group(1))
    return 200, {"status": "connected", "accountId": match.group(1)}


def start_scan(event, context):
    connection_id, connection = _authorized_connection(event)
    if connection.get("status") != "connected":
        raise HttpError(409, "Connect your AWS account before scanning.")
    scan_id = store.new_scan(connection_id)
    # A full scan can outlast API Gateway's 30-second limit, so a worker runs it in the background.
    _lambda_client().invoke(
        FunctionName=os.environ["WORKER_FUNCTION"],
        InvocationType="Event",
        Payload=json.dumps({"connectionId": connection_id, "scanId": scan_id}),
    )
    return 202, {"scanId": scan_id, "status": "running"}


def get_scan(event, context):
    connection_id, _ = _authorized_connection(event)
    scan = store.get_scan(connection_id, event["pathParameters"]["sid"])
    if not scan:
        raise HttpError(404, "Scan not found.")
    fields = ("status", "started_at", "finished_at", "report", "error")
    return 200, {k: scan[k] for k in fields if k in scan}


def explain_finding(event, context):
    connection_id, _ = _authorized_connection(event)
    body = _body(event)
    finding = _stored_finding(connection_id, body)
    try:
        return 200, explain.explain(finding, body.get("language", "en"))
    except ValueError as exc:
        raise HttpError(400, str(exc))


def cleanup_finding(event, context):
    connection_id, connection = _authorized_connection(event)
    body = _body(event)
    finding = _stored_finding(connection_id, body)
    if finding.get("action") not in cleanup.ACTIONS:
        raise HttpError(400, f"There is no automatic action for {finding['kind']}; review it manually.")
    dry_run = body.get("dryRun", True) is not False  # only an explicit false changes anything
    cleanup_role = f"arn:aws:iam::{connection['account_id']}:role/{CLEANUP_ROLE}"
    try:
        session = scanner.session_for(cleanup_role, connection["external_id"])
        result = cleanup.run(session, finding, dry_run)
    except ClientError as exc:
        error = exc.response["Error"]
        if error["Code"] in ("UnauthorizedOperation", "AccessDenied", "AccessDeniedException"):
            raise HttpError(403, "Cleanup isn't switched on for this account. Update the CloudKavachAccess stack "
                                 "and set AllowCleanup to true to create the separate cleanup role.")
        raise HttpError(400, f"AWS refused the change: {error['Message']}")
    log("cleanup", connection=connection_id, action=finding["action"], resource=finding["id"], dry_run=dry_run)
    return 200, result


ROUTES = {
    "POST /connections": create_connection,
    "POST /connections/{cid}/verify": verify_connection,
    "POST /connections/{cid}/scans": start_scan,
    "GET /connections/{cid}/scans/{sid}": get_scan,
    "POST /connections/{cid}/explain": explain_finding,
    "POST /connections/{cid}/cleanup": cleanup_finding,
}


def api(event, context):
    route = ROUTES.get(event.get("routeKey"))
    if route is None:
        return _response(404, {"error": "Not found."})
    try:
        status, body = route(event, context)
        return _response(status, body)
    except HttpError as exc:
        return _response(exc.status, {"error": exc.message})
    except Exception:
        log("unhandled_error", route=event.get("routeKey"), trace=traceback.format_exc()[-1500:])
        return _response(500, {"error": "Something went wrong on our side. Try again in a minute."})


def worker(event, context):
    connection_id, scan_id = event["connectionId"], event["scanId"]
    connection = store.get_connection(connection_id)
    try:
        report = scanner.scan_account(scanner.session_for(connection["role_arn"], connection["external_id"]))
    except Exception as exc:
        # Record the failure so the web app stops polling and can tell the user what to check.
        log("scan_failed", connection=connection_id, scan=scan_id, error=str(exc)[:300])
        store.fail_scan(connection_id, scan_id, "The scan couldn't finish. Check that the CloudKavachAccess role still exists.")
        return
    store.finish_scan(connection_id, scan_id, report)
    log("scan_done", connection=connection_id, scan=scan_id,
        findings=len(report["findings"]), usd_per_day=report["total_usd_per_day"])
