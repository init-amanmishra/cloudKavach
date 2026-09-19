"""Approximate on-demand prices (USD/hour) for the resources people most often forget.

List prices for Linux / on-demand in us-east-1, with regional overrides where they differ a
lot. These answer "roughly how much is this costing me" -- they are not a billing statement.
"""
import os

HOURS_PER_MONTH = 730
USD_INR = float(os.environ.get("USD_INR", "88"))

NAT_GATEWAY = {"default": 0.045, "ap-south-1": 0.056}
LOAD_BALANCER = {"default": 0.0225, "ap-south-1": 0.0239}
PUBLIC_IPV4 = 0.005  # every public IPv4 address is billed since Feb 2024
EKS_CLUSTER = 0.10   # control plane, standard support

EBS_GB_MONTH = {
    "gp3": 0.08, "gp2": 0.10, "io1": 0.125, "io2": 0.125,
    "st1": 0.045, "sc1": 0.015, "standard": 0.05,
}

EC2_HOURLY = {
    "t2.nano": 0.0058, "t2.micro": 0.0116, "t2.small": 0.023, "t2.medium": 0.0464, "t2.large": 0.0928,
    "t3.nano": 0.0052, "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416,
    "t3.large": 0.0832, "t3.xlarge": 0.1664,
    "t3a.micro": 0.0094, "t3a.small": 0.0188, "t3a.medium": 0.0376,
    "t4g.micro": 0.0084, "t4g.small": 0.0168, "t4g.medium": 0.0336,
    "m5.large": 0.096, "m5.xlarge": 0.192, "m6i.large": 0.096, "m7i.large": 0.1008,
    "c5.large": 0.085, "c6i.large": 0.085, "r5.large": 0.126,
    "g4dn.xlarge": 0.526, "g5.xlarge": 1.006, "p3.2xlarge": 3.06,
}

RDS_HOURLY = {
    "db.t3.micro": 0.017, "db.t4g.micro": 0.016, "db.t3.small": 0.034, "db.t4g.small": 0.032,
    "db.t3.medium": 0.068, "db.t4g.medium": 0.065, "db.m5.large": 0.171, "db.r5.large": 0.25,
}

# Rough price by size when a type isn't in the tables above.
_SIZE_FALLBACK = {
    "nano": 0.005, "micro": 0.01, "small": 0.02, "medium": 0.04, "large": 0.09,
    "xlarge": 0.18, "2xlarge": 0.36, "4xlarge": 0.72, "8xlarge": 1.44,
}
_RDS_PREMIUM = 1.8  # managed databases cost roughly this much more than the same-size EC2


def _by_size(instance_type):
    return _SIZE_FALLBACK.get(instance_type.rsplit(".", 1)[-1])


def ec2_hourly(instance_type):
    """Returns (usd_per_hour, is_estimate)."""
    if instance_type in EC2_HOURLY:
        return EC2_HOURLY[instance_type], False
    return _by_size(instance_type), True


def rds_hourly(instance_class, multi_az=False):
    if instance_class in RDS_HOURLY:
        price, estimated = RDS_HOURLY[instance_class], False
    else:
        size_price = _by_size(instance_class)
        price, estimated = (size_price * _RDS_PREMIUM if size_price else None), True
    if price is not None and multi_az:
        price *= 2  # a standby copy runs in a second AZ
    return price, estimated


def ebs_hourly(volume_type, size_gb):
    per_gb = EBS_GB_MONTH.get(volume_type)
    if per_gb is None:
        return EBS_GB_MONTH["gp2"] * size_gb / HOURS_PER_MONTH, True
    return per_gb * size_gb / HOURS_PER_MONTH, False


def nat_gateway_hourly(region):
    return NAT_GATEWAY.get(region, NAT_GATEWAY["default"])


def load_balancer_hourly(region):
    return LOAD_BALANCER.get(region, LOAD_BALANCER["default"])
