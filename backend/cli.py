"""Scan your own AWS account from the terminal:  python cli.py"""
import sys
import time

from cloudkavach import pricing, scanner


def inr(usd):
    return "?" if usd is None else f"₹{usd * pricing.USD_INR:,.0f}"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    print("CloudKavach: scanning every enabled region...\n")
    started = time.perf_counter()
    report = scanner.scan_account(scanner.session_for())
    took = time.perf_counter() - started

    findings = report["findings"]
    if not findings:
        print(f"All clear: nothing billable found across {len(report['regions_scanned'])} regions.")
    else:
        print(f"{'PER DAY':>9}  {'PER MONTH':>10}  {'RESOURCE':<24}{'REGION':<15}{'NAME / ID':<22}VERDICT")
        for f in findings:
            label = (f["name"] or f["id"])[:20]
            est = "~" if f["estimated"] else " "
            print(f"{est}{inr(f['usd_per_day']):>8}  {inr(f['usd_per_month']):>10}  "
                  f"{f['kind'][:23]:<24}{f['region']:<15}{label:<22}{f['verdict'].replace('_', ' ')}")
            for reason in f["reasons"]:
                print(f"{'':>24}· {reason}")
        print(f"\nTotal burn: {inr(report['total_usd_per_day'])}/day, "
              f"{inr(report['total_usd_per_month'])}/month  (~ = estimated price)")
        print(f"Potential savings: {inr(report['potential_usd_per_month'])}/month, "
              f"{inr(report['potential_usd_per_year'])}/year")

    print(f"Scanned {len(report['regions_scanned'])} regions in {took:.1f}s.")
    if report["errors"]:
        print(f"{len(report['errors'])} checks could not run, for example: {report['errors'][0]}")


if __name__ == "__main__":
    main()
