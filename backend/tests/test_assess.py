from datetime import datetime, timezone

from cloudkavach import assess

NOW = datetime(2026, 9, 19, tzinfo=timezone.utc)


def finding(kind, **details):
    return {"kind": kind, "region": "eu-north-1", "id": "res-1", "details": details}


def test_detached_resources_are_likely_forgotten_without_metrics():
    verdict, reasons = assess.classify(finding("Idle Elastic IP"), None, False, NOW)
    assert verdict == assess.LIKELY_FORGOTTEN
    assert reasons == ["Not attached to any instance or network interface"]


def test_quiet_server_is_possibly_idle_and_reports_cpu_and_age():
    ec2 = finding("EC2 instance", launched="2026-07-02T09:14:00+00:00")
    verdict, reasons = assess.classify(ec2, 0.4, False, NOW)
    assert verdict == assess.POSSIBLY_IDLE
    assert reasons == ["CPU averaged 0.4% over the last 7 days", "Running for 78 days"]


def test_busy_server_is_in_use():
    verdict, _ = assess.classify(finding("EC2 instance"), 37.5, False, NOW)
    assert verdict == assess.IN_USE


def test_being_alone_in_a_region_raises_suspicion():
    verdict, reasons = assess.classify(finding("EC2 instance"), 0.4, True, NOW)
    assert verdict == assess.LIKELY_FORGOTTEN
    assert reasons[-1] == "The only billable resource found in eu-north-1"


def test_nat_gateway_without_traffic_is_likely_forgotten():
    verdict, reasons = assess.classify(finding("NAT Gateway"), 0.0, False, NOW)
    assert verdict == assess.LIKELY_FORGOTTEN
    assert reasons[0] == "Almost no traffic in the last 7 days"


def test_missing_metrics_means_not_sure():
    verdict, reasons = assess.classify(finding("RDS database"), None, False, NOW)
    assert verdict == assess.UNKNOWN
    assert reasons == ["No usage data from the last 7 days"]


def test_load_balancer_metric_uses_the_arn_suffix():
    alb = {"kind": "Load balancer (application)", "id": "arn:aws:elasticloadbalancing:ap-south-1:1:loadbalancer/app/web/abc"}
    namespace, metric, dimensions, statistic = assess.usage_query(alb)
    assert (namespace, metric, statistic) == ("AWS/ApplicationELB", "RequestCount", "Sum")
    assert dimensions == [{"Name": "LoadBalancer", "Value": "app/web/abc"}]
