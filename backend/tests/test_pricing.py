from cloudkavach import pricing


def test_known_ec2_type_uses_exact_price():
    assert pricing.ec2_hourly("t3.micro") == (0.0104, False)


def test_unknown_ec2_type_falls_back_by_size():
    assert pricing.ec2_hourly("m99.xlarge") == (0.18, True)


def test_unknown_size_has_no_price():
    assert pricing.ec2_hourly("m99.metal") == (None, True)


def test_multi_az_rds_costs_double():
    single, _ = pricing.rds_hourly("db.t3.micro")
    multi, _ = pricing.rds_hourly("db.t3.micro", multi_az=True)
    assert multi == 2 * single


def test_nat_gateway_uses_regional_price():
    assert pricing.nat_gateway_hourly("ap-south-1") == 0.056
    assert pricing.nat_gateway_hourly("us-east-1") == 0.045


def test_ebs_price_scales_with_size():
    price, estimated = pricing.ebs_hourly("gp3", 100)
    assert not estimated
    assert round(price * pricing.HOURS_PER_MONTH, 2) == 8.0
