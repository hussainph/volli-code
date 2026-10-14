"""VC-767 planning arithmetic; stdlib only, no product or network access.

Sources, read 2026-10-14, and units: docs/plans/volli-cloud-hosted.md.
Published hourly rates are used for managed runtime; Hetzner monthly caps
are used for retained VMs. Active/idle allocation is explanatory, not a
claim that turning a retained VM off stops billing.
"""

from decimal import Decimal, ROUND_HALF_UP


def money(value):
    # Remove binary-float noise below the precision of the published inputs.
    return str(Decimal(str(round(value, 8))).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    ))


PROFILES = {
    "Light": dict(hours=20, disk=10, egress=5, vm=6.49, managed_hour=0.0667,
                  vm_price=59, managed_price=39),
    "Typical": dict(hours=176, disk=30, egress=25, vm=9.99, managed_hour=0.1333,
                    vm_price=79, managed_price=169),
    "Heavy": dict(hours=500, disk=80, egress=100, vm=18.49, managed_hour=0.2667,
                  vm_price=129, managed_price=749),
}
# Millions of uncached input, cache-read input, cache-write input, output tokens.
TOKENS = {"Light": (2, 8, 0.5, 0.4), "Typical": (20, 80, 5, 4),
          "Heavy": (80, 320, 20, 16)}
SOL_RATES = (2, 0.10, 2.50, 10)  # OpenAI Standard, <=272k input/request.
INFERENCE_UPLIFT = 0.25  # Pricing hypothesis; not a provider rate.
MONTH_HOURS = 730
PAID_USERS = 100
CONTROL_FIXED = 200  # Fleet allowance, not a vendor quote.
CONTROL_VARIABLE = 2  # Per-user allowance, not a vendor quote.
IP_ALLOWANCE = 1  # VM IPv4/routing contingency, not a quoted IP price.
DISK_GB_MONTH = 0.15  # Northflank persistent SSD.
EGRESS_GB = 0.06  # Northflank Internet egress; ingress free.
BACKUP_GB_MONTH = 0.015  # R2 Standard; no free allowance credited.
BACKUP_MULTIPLIER = 2  # Incremental retention cap, not daily full copies.
OBJECT_OPERATIONS = 0.05  # ~10k writes + 10k reads/user/month, fleet allocation.
RESERVE = 0.25  # Capacity, incidents, provider extras; excludes salaries.
PAYMENT_FRACTION = 0.03  # Planning allowance, not a processor quote.
TARGET_MARGIN = 0.70


def infrastructure(profile, route):
    control = CONTROL_FIXED / PAID_USERS + CONTROL_VARIABLE
    backup = profile["disk"] * BACKUP_MULTIPLIER * BACKUP_GB_MONTH
    if route == "VM":
        compute = profile["vm"]
        active = compute * profile["hours"] / MONTH_HOURS
        idle = compute - active
        storage = 0  # Included root disk; profiles must fit.
        network = IP_ALLOWANCE
        price = profile["vm_price"]
    else:
        active = profile["hours"] * profile["managed_hour"]
        idle = 0  # True only after successful stop; live waiting is active.
        compute = active
        storage = profile["disk"] * DISK_GB_MONTH
        network = profile["egress"] * EGRESS_GB
        price = profile["managed_price"]
    raw = compute + storage + backup + OBJECT_OPERATIONS + network + control
    budget = raw * (1 + RESERVE)
    floor = budget / (1 - TARGET_MARGIN - PAYMENT_FRACTION)
    margin = 1 - budget / price - PAYMENT_FRACTION
    return dict(active=active, idle=idle, storage=storage, backup=backup,
                operations=OBJECT_OPERATIONS, network=network, control=control,
                raw=raw, budget=budget, floor=floor, price=price, margin=margin)


def main():
    print("Infrastructure: USD/user/month; N=100; inference excluded")
    print("route,profile,active,idle,disk,backup,operations,network,control,"
          "raw,budget_25pct,price_floor_70pct,price,margin")
    for route in ("VM", "Managed"):
        for name, profile in PROFILES.items():
            row = infrastructure(profile, route)
            values = [money(value) for key, value in row.items() if key != "margin"]
            print(",".join([route, name, *values, f"{row['margin']:.1%}"]))
            assert abs(row["active"] + row["idle"] - (
                profile["vm"] if route == "VM" else
                profile["hours"] * profile["managed_hour"]
            )) < 1e-9
            assert row["margin"] >= TARGET_MARGIN
    print("Inference: profile,provider_cost,customer_charge_25pct,"
          "vm_total_bill,vm_blended_margin,managed_total_bill,managed_blended_margin")
    for name, profile in PROFILES.items():
        inference = sum(tokens * rate for tokens, rate in zip(TOKENS[name], SOL_RATES))
        charge = inference * (1 + INFERENCE_UPLIFT)
        values = [name, money(inference), money(charge)]
        for route in ("VM", "Managed"):
            row = infrastructure(profile, route)
            bill = row["price"] + charge
            margin = 1 - (row["budget"] + inference) / bill - PAYMENT_FRACTION
            values.extend([money(bill), f"{margin:.1%}"])
        print(",".join(values))
    print("Control-plane allowance/user at N=10,100,1000:",
          [CONTROL_FIXED / count + CONTROL_VARIABLE for count in (10, 100, 1000)])
    print("Typical extra 8h overnight: VM within cap=$0; managed=$"
          f"{8 * PROFILES['Typical']['managed_hour']:.2f}")
    print("Managed always-on budgets (no sleep), N=100:")
    for name, profile in PROFILES.items():
        awake = {**profile, "hours": MONTH_HOURS}
        print(f"  {name}: ${money(infrastructure(awake, 'Managed')['budget'])}")
    print("Bare metal illustration: 2 x AX42-1; setup amortized over 12 months")
    fleet = 2 * (117.10 + 59 / 12)
    slots = 2 * 4  # Hypothesis: four safe 4-vCPU/8-GB slots per physical host.
    for occupancy in (0.25, 0.70, 1.0):
        print(f"  {occupancy:.0%} occupancy: ${fleet / (slots * occupancy):.2f}"
              " per occupied slot-month, before disk/control/labor")


if __name__ == "__main__":
    main()
