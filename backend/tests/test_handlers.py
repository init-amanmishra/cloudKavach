import pytest

from cloudkavach import cleanup, explain, handlers


def test_unknown_route_returns_404():
    assert handlers.api({"routeKey": "GET /nope"}, None)["statusCode"] == 404


def test_only_the_access_role_name_is_accepted():
    assert handlers.ROLE_ARN.match("arn:aws:iam::123456789012:role/CloudKavachAccess")
    assert not handlers.ROLE_ARN.match("arn:aws:iam::123456789012:role/AdminRole")


def test_cleanup_refuses_anything_outside_the_safe_list():
    ebs = {"kind": "Unattached EBS volume", "action": None, "region": "ap-south-1", "id": "vol-1"}
    with pytest.raises(ValueError):
        cleanup.run(session=None, finding=ebs)


def test_explain_rejects_unknown_language():
    with pytest.raises(ValueError):
        explain.explain({"kind": "EC2 instance"}, language="fr")


def test_prompt_states_cost_in_rupees_and_asks_for_the_language():
    finding = {"kind": "NAT Gateway", "region": "ap-south-1", "id": "nat-1", "usd_per_day": 1.34, "details": {}}
    prompt = explain.build_prompt(finding, "hinglish")
    assert "₹118 per day" in prompt
    assert "Hinglish" in prompt
