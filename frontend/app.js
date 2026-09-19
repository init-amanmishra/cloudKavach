/* CloudKavach web app. Plain JavaScript with hash routing and no build step, so S3 can serve it as-is.
 *
 *   #/                        landing page
 *   #/connect                 connect wizard
 *   #/app                     overview
 *   #/app/resources           resources table
 *   #/app/resources/<key>     resources table with one resource open in the drawer
 *   #/app/account             connected account and how to revoke access
 */
(() => {
  "use strict";

  // ---------- Configuration ----------

  const CONFIG = window.KAVACH_CONFIG || {};
  const API_URL = (CONFIG.apiUrl || "").replace(/\/+$/, "");
  const PREVIEW = API_URL === "";
  const USD_INR = Number(CONFIG.usdInr) || 88;
  const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/CloudKavachAccess$/;
  const SAMPLE_ARN = "arn:aws:iam::123456789012:role/CloudKavachAccess";
  const GITHUB_URL = "https://github.com/init-amanmishra/cloudkavach";
  const STORE = { connection: "cloudkavach.connection", scan: "cloudkavach.scan", credits: "cloudkavach.credits" };
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const REGIONS = {
    "us-east-1": "N. Virginia", "us-east-2": "Ohio", "us-west-1": "N. California", "us-west-2": "Oregon",
    "ca-central-1": "Canada", "ca-west-1": "Calgary", "mx-central-1": "Mexico", "sa-east-1": "São Paulo",
    "eu-west-1": "Ireland", "eu-west-2": "London", "eu-west-3": "Paris", "eu-central-1": "Frankfurt",
    "eu-central-2": "Zurich", "eu-north-1": "Stockholm", "eu-south-1": "Milan", "eu-south-2": "Spain",
    "ap-south-1": "Mumbai", "ap-south-2": "Hyderabad", "ap-northeast-1": "Tokyo", "ap-northeast-2": "Seoul",
    "ap-northeast-3": "Osaka", "ap-southeast-1": "Singapore", "ap-southeast-2": "Sydney",
    "ap-southeast-3": "Jakarta", "ap-southeast-4": "Melbourne", "ap-southeast-5": "Malaysia",
    "ap-southeast-7": "Thailand", "ap-east-1": "Hong Kong", "me-south-1": "Bahrain", "me-central-1": "UAE",
    "il-central-1": "Tel Aviv", "af-south-1": "Cape Town",
  };

  const CHECKS = ["EC2 instances", "NAT Gateways", "Elastic IPs", "EBS volumes", "Load balancers", "RDS databases", "EKS clusters"];

  const ACTIONS = {
    stop_instance: {
      verb: "Stop instance", style: "primary", done: "Stopped",
      effect: "The instance stops billing for compute. Its disk and data are kept, and you can start it again from the EC2 console.",
      doneMessage: (id) => `Stopping instance ${id}. Its disk is kept, so you can start it again any time.`,
    },
    release_address: {
      verb: "Release IP", style: "primary", done: "Released",
      effect: "The address goes back to AWS and stops billing. You may not get the same address again.",
      doneMessage: (id) => `Released Elastic IP ${id}.`,
    },
    delete_nat_gateway: {
      verb: "Delete NAT Gateway", style: "danger", done: "Deleted",
      effect: "The gateway stops billing. Servers in private subnets lose internet access until you create a new one.",
      doneMessage: (id) => `Deleting NAT Gateway ${id}. It stops billing once the deletion finishes.`,
    },
    stop_db_instance: {
      verb: "Stop database", style: "primary", done: "Stopped",
      effect: "The database stops billing for compute and keeps its data. AWS starts it again automatically after 7 days.",
      doneMessage: (id) => `Stopping database ${id}. AWS will start it again after 7 days.`,
    },
  };

  const LANGUAGES = [["en", "English"], ["hinglish", "Hinglish"], ["hi", "हिंदी"]];
  const TITLES = { overview: "Overview", resources: "Resources", account: "Account" };

  // Official AWS Architecture Icons, stored in icons/.
  const KIND_ICON = {
    "EC2 instance": "ec2", "NAT Gateway": "nat", "Idle Elastic IP": "eip",
    "Unattached EBS volume": "ebs", "RDS database": "rds", "EKS cluster": "eks",
  };
  const iconFor = (kind) => `icons/${KIND_ICON[kind] || (kind.startsWith("Load balancer") ? "elb" : "vpc")}.svg`;

  // ---------- Landing content ----------

  const SECTIONS = [["how", "How it works"], ["features", "What you get"], ["compare", "Compare"], ["security", "Security"]];

  const WATCHES = [
    ["ec2", "EC2 instances"], ["nat", "NAT Gateways"], ["eip", "Elastic IPs"], ["ebs", "EBS volumes"],
    ["elb", "Load balancers"], ["rds", "RDS databases"], ["eks", "EKS clusters"],
  ];

  // Resources scattered across regions, drawn in the first step of "How it works".
  const ACCOUNT_SCATTER = [["ec2", "eu-n-1"], ["nat", "ap-s-1"], ["rds", "us-e-1"], ["eip", "ap-s-1"], ["ebs", "ap-s-1"], ["elb", "us-w-2"]];

  // How sure CloudKavach is that a resource is waste. Something existing is not the same as something wasted.
  const VERDICTS = {
    likely_forgotten: { label: "Likely forgotten", tone: "bad" },
    possibly_idle: { label: "Possibly idle", tone: "warn" },
    in_use: { label: "In use", tone: "" },
    unknown: { label: "Not sure", tone: "muted" },
  };
  const POTENTIAL = ["likely_forgotten", "possibly_idle"];

  function verdictChip(f) {
    const v = VERDICTS[f.verdict] || VERDICTS.unknown;
    return `<span class="chip${v.tone ? ` chip-${v.tone}` : ""}">${v.label}</span>`;
  }

  // [resource, icon, USD per hour]
  const SUSPECTS = [
    ["EKS cluster", "eks", 0.10],
    ["NAT Gateway", "nat", 0.056],
    ["Load balancer", "elb", 0.0239],
    ["RDS db.t3.micro", "rds", 0.017],
    ["EC2 t3.micro", "ec2", 0.0104],
    ["Idle Elastic IP", "eip", 0.005],
    ["EBS volume, 20 GB", "ebs", (0.08 * 20) / 730],
  ];

  const TOOLS = [
    ["CloudKavach", ""], ["AWS Budgets", ""], ["Cost Explorer", ""], ["Compute Optimizer", ""],
    ["Trusted Advisor", ""], ["Open-source tools", "Cloud Custodian, aws-nuke"],
  ];

  // Each row: [question, one [mark, note] per tool in TOOLS order]
  const MATRIX = [
    ["Shows what is running right now, in every region",
      [["yes"], ["no", "Alerts after the spend"], ["no", "About a day behind"], ["no", "Needs 14–32 days of data"], ["part", "Periodic checks"], ["yes"]]],
    ["Names the exact resource",
      [["yes"], ["no"], ["part", "Opt-in, limited services"], ["yes"], ["yes"], ["yes"]]],
    ["Works on a free Basic Support account",
      [["yes"], ["yes"], ["yes"], ["yes"], ["no", "Cost checks need Business Support+"], ["yes"]]],
    ["Nothing to install or configure",
      [["yes", "One CloudFormation stack"], ["yes"], ["yes"], ["part", "Opt-in required"], ["yes"], ["no", "Install and write policies"]]],
    ["Explains it in Hindi, Hinglish or English",
      [["yes"], ["no"], ["no"], ["no"], ["no"], ["no"]]],
    ["Safe, reversible cleanup",
      [["yes", "Dry run, then confirm"], ["part", "Budget actions can stop EC2 and RDS"], ["no"], ["no"], ["no"], ["part", "Powerful, easy to over-delete"]]],
  ];

  // Must match infra/connect-role.yaml.
  const SCAN_PERMISSIONS = [
    "ec2:DescribeRegions", "ec2:DescribeInstances", "ec2:DescribeNatGateways", "ec2:DescribeAddresses",
    "ec2:DescribeVolumes", "elasticloadbalancing:DescribeLoadBalancers", "rds:DescribeDBInstances",
    "eks:ListClusters", "cloudwatch:GetMetricStatistics",
  ];
  const CLEANUP_PERMISSIONS = ["ec2:StopInstances", "ec2:ReleaseAddress", "ec2:DeleteNatGateway", "rds:StopDBInstance"];

  const NEVER = [
    "Read the files in your S3 buckets",
    "Read what is inside your databases",
    "See secrets, keys or environment variables",
    "Delete an EBS volume or anything else that holds data",
    "Keep any access once you delete the stack",
  ];

  const ICON = {
    brand: `<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path class="shield" d="M12 2.5 4 5.5v6.2c0 4.9 3.3 8.6 8 9.8 4.7-1.2 8-4.9 8-9.8V5.5l-8-3z"/><path class="tick" d="M8.5 12.2l2.4 2.4 4.6-4.9"/></svg>`,
    overview: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>`,
    resources: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>`,
    account: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.5" cy="8" r="3"/><path d="M8.5 8H14M12 8v2.5"/></svg>`,
    close: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
    chevron: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`,
    check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`,
    cross: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`,
    power: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v5"/><path d="M4.8 4.6a4.6 4.6 0 1 0 6.4 0"/></svg>`,
    eye: `<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="9" cy="9" r="2.2"/></svg>`,
    key: `<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="6" cy="9" r="3.2"/><path d="M9.2 9H16M13.5 9v2.6M15.8 9v1.8"/></svg>`,
    undo: `<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5 6.5h6a4 4 0 0 1 0 8H7"/><path d="M7.5 4 5 6.5 7.5 9"/></svg>`,
    user: `<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="6.5" r="2.8"/><path d="M3.5 15.5c.9-2.6 3-4 5.5-4s4.6 1.4 5.5 4"/></svg>`,
    scan: `<svg class="ico-scan" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5v-2A1.5 1.5 0 0 1 3.5 2h2M10.5 2h2A1.5 1.5 0 0 1 14 3.5v2M14 10.5v2a1.5 1.5 0 0 1-1.5 1.5h-2M5.5 14h-2A1.5 1.5 0 0 1 2 12.5v-2"/><path class="scanline" d="M4.5 8h7"/></svg>`,
    github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
  };

  const MARK = {
    yes: `<span class="mk mk-yes"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg><span class="visually-hidden">Yes</span></span>`,
    no: `<span class="mk mk-no"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8h7"/></svg><span class="visually-hidden">No</span></span>`,
    part: `<span class="mk mk-part"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path class="half" d="M8 2.5a5.5 5.5 0 0 1 0 11z"/></svg><span class="visually-hidden">Partly</span></span>`,
  };

  // ---------- Preview data (used only when no API is configured) ----------

  const SAMPLE_REPORT = {
    regions_scanned: [
      "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1", "ap-south-2", "ap-southeast-1",
      "ap-southeast-2", "ca-central-1", "eu-central-1", "eu-north-1", "eu-west-1", "eu-west-2", "eu-west-3",
      "sa-east-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    ],
    errors: [],
    findings: [
      {
        kind: "NAT Gateway", region: "ap-south-1", id: "nat-0b7e41c2d9a35f168", name: "project-nat",
        usd_per_hour: 0.056, usd_per_day: 1.34, usd_per_month: 40.88, estimated: false,
        details: { vpc: "vpc-04c1e9a7b2d3f5e60", created: "2026-03-19T11:02:00+00:00" }, action: "delete_nat_gateway",
        verdict: "likely_forgotten", reasons: ["Almost no traffic in the last 7 days", "Created 183 days ago"],
      },
      {
        kind: "EC2 instance", region: "eu-north-1", id: "i-0c3f1a9e27b54d810", name: "CiCd",
        usd_per_hour: 0.0104, usd_per_day: 0.25, usd_per_month: 7.59, estimated: false,
        details: { type: "t3.micro", launched: "2026-09-09T08:20:00+00:00" }, action: "stop_instance",
        verdict: "possibly_idle", reasons: ["CPU averaged 0.4% over the last 7 days", "Running for 10 days"],
      },
      {
        kind: "EC2 instance", region: "eu-north-1", id: "i-07d2b8e4f16a3c952", name: "UbuntuSrever",
        usd_per_hour: 0.0104, usd_per_day: 0.25, usd_per_month: 7.59, estimated: false,
        details: { type: "t3.micro", launched: "2026-04-11T16:40:00+00:00" }, action: "stop_instance",
        verdict: "possibly_idle", reasons: ["CPU averaged 0.2% over the last 7 days", "Running for 161 days"],
      },
      {
        kind: "Idle Elastic IP", region: "ap-south-1", id: "eipalloc-0a9c3e71f5b2d4086", name: null,
        usd_per_hour: 0.005, usd_per_day: 0.12, usd_per_month: 3.65, estimated: false,
        details: { ip: "203.0.113.24" }, action: "release_address",
        verdict: "likely_forgotten", reasons: ["Not attached to any instance or network interface"],
      },
      {
        kind: "Unattached EBS volume", region: "ap-south-1", id: "vol-0e5a2c8b91d47f3a6", name: "old-data",
        usd_per_hour: 0.0022, usd_per_day: 0.05, usd_per_month: 1.6, estimated: false,
        details: { type: "gp3", size_gb: 20, created: "2026-02-19T07:45:00+00:00" }, action: null,
        verdict: "likely_forgotten", reasons: ["Not attached to any instance", "Created 211 days ago"],
      },
    ],
  };

  const SAMPLE_TEXT = {
    en: {
      "EC2 instance": "A virtual server that is switched on. AWS bills every hour it runs, even if nothing uses it. Stopping it is safe: the disk is kept and you can start it again later, though its public IP may change.",
      "NAT Gateway": "A gateway that lets private servers reach the internet. It is billed every hour it exists, even with zero traffic, which makes it one of the most commonly forgotten charges. Deleting it is safe if no private server needs the internet, and you can create a new one later.",
      "Idle Elastic IP": "A public IP address that is reserved but attached to nothing. AWS bills every public IPv4 address. Releasing it is safe unless you need to keep this exact address.",
      "Unattached EBS volume": "A virtual hard disk that is not attached to any server. You pay for its storage every month. Deleting it destroys its data, so check what is on it or take a snapshot first.",
    },
    hinglish: {
      "EC2 instance": "Ye ek EC2 server hai jo har din lagbhag ₹22 ka bill la raha hai, chahe aap use karo ya nahi. Band karne se data safe rahega, aur baad me wapas chalu kar sakte ho.",
      "NAT Gateway": "Ye NAT Gateway private servers ko internet deta hai. Ye har ghante ka paisa leta hai, traffic ho ya na ho, isliye log ise sabse zyada bhoolte hain. Kisi private server ko internet nahi chahiye toh delete karna safe hai.",
    },
    hi: {
      "EC2 instance": "यह एक EC2 सर्वर है जो हर दिन लगभग ₹22 का बिल बना रहा है, चाहे आप इसे इस्तेमाल करें या नहीं। इसे बंद करना सुरक्षित है: डिस्क और डेटा बचे रहेंगे, और आप इसे बाद में फिर चालू कर सकते हैं।",
    },
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const previewApi = {
    async createConnection() { await sleep(500); return { connectionId: "preview", key: "preview", launchUrl: "" }; },
    async verify(roleArn) { await sleep(800); return { status: "connected", accountId: ROLE_ARN.exec(roleArn)[1] }; },
    async startScan() { await sleep(300); return { scanId: "preview" }; },
    async getScan() { await sleep(2400); return { status: "done", finished_at: Date.now() / 1000, report: SAMPLE_REPORT }; },
    async explain(f, language) {
      await sleep(900);
      const text = SAMPLE_TEXT[language]?.[f.kind] || SAMPLE_TEXT.en[f.kind] || "This resource is running and AWS bills it by the hour.";
      return { text, source: "sample" };
    },
    async cleanup(f, dryRun) {
      await sleep(dryRun ? 700 : 1200);
      return dryRun
        ? { dry_run: true, message: `Permission check passed for ${f.id}. Nothing was changed.` }
        : { dry_run: false, message: ACTIONS[f.action].doneMessage(f.id) };
    },
  };

  // ---------- Live API ----------

  async function request(method, path, body) {
    const headers = { "content-type": "application/json" };
    if (state.connection?.key) headers["x-kavach-key"] = state.connection.key;
    let response;
    try {
      response = await fetch(API_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Couldn't reach CloudKavach. Check your internet connection and try again.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `CloudKavach returned an error (${response.status}).`);
    return data;
  }

  const cid = () => encodeURIComponent(state.connection.connectionId);

  const liveApi = {
    createConnection: () => request("POST", "/connections"),
    verify: (roleArn) => request("POST", `/connections/${cid()}/verify`, { roleArn }),
    startScan: () => request("POST", `/connections/${cid()}/scans`),
    getScan: (scanId) => request("GET", `/connections/${cid()}/scans/${encodeURIComponent(scanId)}`),
    explain: (f, language) => request("POST", `/connections/${cid()}/explain`,
      { scanId: state.scan.scanId, findingId: f.id, region: f.region, language }),
    cleanup: (f, dryRun) => request("POST", `/connections/${cid()}/cleanup`,
      { scanId: state.scan.scanId, findingId: f.id, region: f.region, dryRun }),
  };

  const api = PREVIEW ? previewApi : liveApi;

  // ---------- State ----------

  const saved = {
    read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
  };

  const state = {
    connection: PREVIEW ? null : saved.read(STORE.connection),
    scan: PREVIEW ? null : saved.read(STORE.scan),   // { scanId, finished_at, report, cleaned: { key: message } }
    roleArn: PREVIEW ? SAMPLE_ARN : "",
    credits: PREVIEW ? "100" : (saved.read(STORE.credits) ?? ""),
    creating: false,
    busy: false,
    error: null,
    scanning: false,
    scanError: null,
    scanStartedAt: 0,
    lang: "en",
    filter: "all",
    explanations: {},  // "<key>|<language>" -> { status, text, source, error }
    cleanups: {},      // key -> { status: checking | confirm | running | error, message }
  };

  if (!state.connection) state.scan = null;

  const connected = () => state.connection?.status === "connected";

  function persistConnection() { if (!PREVIEW) saved.write(STORE.connection, state.connection); }
  function persistScan() { if (!PREVIEW) saved.write(STORE.scan, state.scan); }

  // ---------- Formatting ----------

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function rupees(usd) {
    if (usd == null) return "Unknown";
    const inr = usd * USD_INR;
    if (inr > 0 && inr < 1) return "<₹1";
    return "₹" + Math.round(inr).toLocaleString("en-IN");
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const regionName = (code) => REGIONS[code] || code;
  const maskAccount = (id) => `••••${String(id || "").slice(-4)}`;
  const keyOf = (f) => `${f.region}|${f.id}`;
  const hrefFor = (f) => `#/app/resources/${encodeURIComponent(keyOf(f))}`;

  // "ap-northeast-1" -> "ap-ne-1", short enough for the region grid in the hero.
  const shortRegion = (code) => code
    .replace("northeast", "ne").replace("southeast", "se").replace("central", "c")
    .replace("north", "n").replace("south", "s").replace("east", "e").replace("west", "w");

  function severity(usdPerDay) {
    const inr = (usdPerDay || 0) * USD_INR;
    return inr >= 100 ? "critical" : inr >= 20 ? "warning" : "low";
  }

  function ago(epochSeconds) {
    const seconds = Date.now() / 1000 - Number(epochSeconds);
    if (!Number.isFinite(seconds) || seconds < 45) return "just now";
    if (seconds < 90) return "a minute ago";
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
    if (seconds < 172800) return `${plural(Math.round(seconds / 3600), "hour")} ago`;
    return `${Math.round(seconds / 86400)} days ago`;
  }

  function howLong(days) {
    if (days < 1) return "less than a day";
    if (days < 90) return plural(Math.floor(days), "day");
    if (days < 730) return `about ${Math.round(days / 30)} months`;
    return "more than 2 years";
  }

  function fmtDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  function detailLine(f) {
    const d = f.details || {};
    if (f.kind === "EC2 instance") return d.type;
    if (f.kind === "NAT Gateway") return d.vpc;
    if (f.kind === "Idle Elastic IP") return d.ip;
    if (f.kind === "Unattached EBS volume") return `${d.size_gb} GB ${d.type}`;
    if (f.kind === "RDS database") return [d.class, d.engine, d.multi_az ? "Multi-AZ" : null].filter(Boolean).join(" · ");
    if (f.kind === "EKS cluster") return "Control plane";
    if (f.kind.startsWith("Load balancer")) return d.state;
    return "";
  }

  function consoleUrl(f) {
    const r = encodeURIComponent(f.region);
    const id = encodeURIComponent(f.id);
    const base = `https://${r}.console.aws.amazon.com`;
    if (f.kind === "EC2 instance") return `${base}/ec2/home?region=${r}#InstanceDetails:instanceId=${id}`;
    if (f.kind === "NAT Gateway") return `${base}/vpcconsole/home?region=${r}#NatGatewayDetails:natGatewayId=${id}`;
    if (f.kind === "Idle Elastic IP") return `${base}/ec2/home?region=${r}#ElasticIpDetails:AllocationId=${id}`;
    if (f.kind === "Unattached EBS volume") return `${base}/ec2/home?region=${r}#VolumeDetails:volumeId=${id}`;
    if (f.kind === "RDS database") return `${base}/rds/home?region=${r}#database:id=${id}`;
    if (f.kind === "EKS cluster") return `${base}/eks/home?region=${r}#/clusters/${id}`;
    return `${base}/ec2/home?region=${r}#LoadBalancers:search=${encodeURIComponent(f.name || "")}`;
  }

  const awsIcon = (kind, size) => `<img class="aws-icon" src="${iconFor(kind)}" alt="" width="${size}" height="${size}">`;

  // ---------- Findings ----------

  const findings = () => state.scan?.report.findings || [];
  const findByKey = (key) => findings().find((f) => keyOf(f) === key);
  const isDone = (f) => Boolean(state.scan?.cleaned?.[keyOf(f)]);
  const active = () => findings().filter((f) => !isDone(f));
  const perDay = (list) => list.reduce((total, f) => total + (f.usd_per_day || 0), 0);
  const perMonth = (list) => list.reduce((total, f) => total + (f.usd_per_month || 0), 0);

  function byRegion(list) {
    const totals = new Map();
    list.forEach((f) => totals.set(f.region, (totals.get(f.region) || 0) + (f.usd_per_day || 0)));
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }

  const potential = (list) => list.filter((f) => POTENTIAL.includes(f.verdict));

  const FILTERS = [
    ["all", "All", () => true],
    ["likely_forgotten", "Likely forgotten", (f) => f.verdict === "likely_forgotten" && !isDone(f)],
    ["possibly_idle", "Possibly idle", (f) => f.verdict === "possibly_idle" && !isDone(f)],
    ["active", "In use or not sure", (f) => !POTENTIAL.includes(f.verdict) && !isDone(f)],
    ["done", "Switched off", (f) => isDone(f)],
  ];

  // ---------- Routing ----------

  function decodePart(part) {
    try { return decodeURIComponent(part); } catch { return null; }
  }

  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "connect") return { page: "connect", item: null };
    if (parts[0] === "app") {
      if (parts[1] === "resources") return { page: "resources", item: parts[2] ? decodePart(parts[2]) : null };
      if (parts[1] === "account") return { page: "account", item: null };
      return { page: "overview", item: null };
    }
    return { page: "landing", item: null };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  // ---------- Shared pieces ----------

  function notice(message, kind = "error") {
    if (!message) return "";
    return `<p class="notice notice-${kind}" role="${kind === "error" ? "alert" : "status"}">${esc(message)}</p>`;
  }

  function elapsed() {
    return `${Math.round((Date.now() - state.scanStartedAt) / 1000)}s`;
  }

  function scanningCard() {
    return `
      <section class="card scan-card" aria-live="polite">
        <h2>Checking every region</h2>
        <div class="progress" role="progressbar" aria-label="Scan in progress"></div>
        <p class="hint">Looking for running EC2 instances, NAT Gateways, idle Elastic IPs, unattached EBS volumes,
          load balancers, RDS databases and EKS clusters. Elapsed <span data-elapsed>${elapsed()}</span>.</p>
      </section>`;
  }

  function firstScanCard() {
    return `
      ${notice(state.scanError)}
      <section class="card empty-state">
        <h2>Run your first scan</h2>
        <p>One scan checks every enabled region for ${CHECKS.length} kinds of billable resources. It usually takes under 30 seconds.</p>
        <button class="btn btn-primary" id="scan-first" data-action="scan">${ICON.scan}Scan my account</button>
      </section>`;
  }

  function langSwitch() {
    return `
      <div class="seg" role="group" aria-label="Explanation language">
        ${LANGUAGES.map(([code, label]) => `<button id="lang:${code}" data-action="lang" data-lang="${code}"
          aria-pressed="${state.lang === code}"${code === "hi" ? ' lang="hi"' : ""}>${label}</button>`).join("")}
      </div>`;
  }

  // ---------- Public pages ----------

  function siteLayout(content, minimal = false) {
    const action = connected()
      ? `<a class="btn btn-primary btn-sm pill" href="#/app">Open dashboard</a>`
      : minimal
        ? `<a class="btn btn-secondary btn-sm pill" href="#/">Back to home</a>`
        : `<a class="btn btn-primary btn-sm pill" href="#/connect">${ICON.scan}Scan my account</a>`;
    return `
      <div class="site">
        <header class="site-header">
          <div class="wrap header-bar">
            <a class="brand" href="#/">${ICON.brand}<span>CloudKavach</span></a>
            ${minimal ? "<span></span>" : `<nav class="site-nav" aria-label="Sections">
              ${SECTIONS.map(([id, label]) => `<button data-action="scroll-to" data-target="${id}" data-spy="${id}">${label}</button>`).join("")}
              <span class="nav-indicator" aria-hidden="true"></span>
            </nav>`}
            <div class="header-actions">${action}</div>
          </div>
        </header>
        <main class="site-main">${content}</main>
        ${siteFooter()}
      </div>`;
  }

  function siteFooter() {
    const external = 'target="_blank" rel="noopener noreferrer"';
    return `
      <footer class="site-footer">
        <div class="wrap footer-grid">
          <div class="footer-brand">
            <a class="brand" href="#/">${ICON.brand}<span>CloudKavach</span></a>
            <p>Find the AWS resources quietly billing you, and switch them off safely.</p>
          </div>
          <nav aria-labelledby="footer-product">
            <h2 id="footer-product">Product</h2>
            <button class="footer-link" data-action="scroll-to" data-target="how">How it works</button>
            <button class="footer-link" data-action="scroll-to" data-target="features">What you get</button>
            <button class="footer-link" data-action="scroll-to" data-target="compare">Compare</button>
            <a class="footer-link" href="#/connect">Connect an account</a>
          </nav>
          <nav aria-labelledby="footer-trust">
            <h2 id="footer-trust">Trust</h2>
            <button class="footer-link" data-action="scroll-to" data-target="security">Security</button>
            <a class="footer-link" href="${GITHUB_URL}/blob/main/infra/connect-role.yaml" ${external}>Access-role template</a>
            <a class="footer-link" href="${GITHUB_URL}" ${external}>Source code</a>
          </nav>
        </div>
        <div class="wrap footer-bottom">
          <span>© 2026 CloudKavach · Made in India</span>
        </div>
      </footer>`;
  }

  // Every enabled region checked; the two with forgotten resources in red.
  function regionsCard() {
    const regions = SAMPLE_REPORT.regions_scanned;
    const spending = new Set(SAMPLE_REPORT.findings.map((f) => f.region));
    return `
      <div class="card mini regions-card">
        <div class="mini-total"><span>Regions checked</span><strong class="plain">${regions.length} of ${regions.length}</strong></div>
        <div class="region-grid" aria-hidden="true">
          ${regions.map((r) => `<span class="rc ${spending.has(r) ? "hit" : "checked"}" title="${r}">${shortRegion(r)}</span>`).join("")}
        </div>
        <div class="mini-total">
          <span>${SAMPLE_REPORT.findings.length} resources in ${spending.size} regions</span>
          <strong class="bad">${rupees(perDay(SAMPLE_REPORT.findings))} a day</strong>
        </div>
      </div>`;
  }

  // The hero's bill: seven forgotten resources, printed line by line.
  function receiptCard() {
    const total = SUSPECTS.reduce((sum, [, , hourly]) => sum + hourly * 730, 0);
    return `
      <div class="rise" style="--i:2">
        <div class="receipt-wrap">
          <figure class="receipt" aria-label="Example bill for seven resources forgotten for one month">
            <div class="receipt-head"><strong>Forgotten for 1 month</strong><span>INR · on-demand</span></div>
            <ul class="receipt-lines">
              ${SUSPECTS.map(([name, icon, hourly], n) => `
                <li style="--n:${n}">
                  <img src="icons/${icon}.svg" alt="" width="22" height="22">
                  <span>${name}</span>
                  <span class="leader" aria-hidden="true"></span>
                  <span class="amt">${rupees(hourly * 730)}</span>
                </li>`).join("")}
            </ul>
            <div class="receipt-total"><span>Total</span><span class="amt">${rupees(total)}</span></div>
            <p class="receipt-note">Approximate on-demand prices, before free tier and credits</p>
          </figure>
        </div>
      </div>`;
  }

  // Five panels that slide sideways while the page scrolls down: scan, price, judge, explain, clean up.
  function featuresSection() {
    const ubuntu = SAMPLE_REPORT.findings[2];
    const priced = [0, 1, 3].map((i) => SAMPLE_REPORT.findings[i]);
    const yearly = perMonth(potential(SAMPLE_REPORT.findings)) * 12;
    const panels = [
      ["Scan", "Every region, at once",
        "One scan checks every enabled region in parallel, so the server you left in Stockholm shows up right next to the one in Mumbai.",
        regionsCard()],
      ["Price", "Priced in rupees, not dollars",
        "Each resource shows what it costs per day and per month, in Indian number format, so an idle NAT Gateway at ₹3,597 a month actually registers.",
        `<div class="card mini">
          ${priced.map((f) => `
            <div class="mini-line">
              <img src="${iconFor(f.kind)}" alt="" width="24" height="24">
              <span>${esc(f.kind)} <span class="hint">· ${esc(regionName(f.region))}</span></span>
              <span class="mini-amt">${rupees(f.usd_per_month)}<span class="hint"> /mo</span></span>
            </div>`).join("")}
          <div class="mini-total"><span>Potential savings</span><strong>${rupees(yearly)} a year</strong></div>
        </div>`],
      ["Judge", "A verdict, with the evidence",
        "Existing isn't the same as wasted. CloudKavach reads 7 days of CloudWatch usage and shows exactly why it flagged something.",
        `<div class="card mini">
          <div class="mini-line">
            ${awsIcon(ubuntu.kind, 24)}
            <span>${esc(ubuntu.name)} <span class="hint">· ${esc(regionName(ubuntu.region))}</span></span>
            ${verdictChip(ubuntu)}
          </div>
          <ul class="why-list">${ubuntu.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>
          <div class="mini-total"><span>Potential saving</span><strong>${rupees(ubuntu.usd_per_month)} a month</strong></div>
        </div>`],
      ["Explain", "Explained in your language",
        "Amazon Bedrock explains each resource in English, Hinglish or Hindi: what it is, why it costs money, and whether turning it off is safe.",
        `<div class="card mini" data-lang-demo>
          <div class="seg" aria-hidden="true">
            ${LANGUAGES.map(([code, label]) => `<span data-lang-tab="${code}" class="${code === "hinglish" ? "on" : ""}"${code === "hi" ? ' lang="hi"' : ""}>${label}</span>`).join("")}
          </div>
          <p class="explain-text" data-lang-text>${esc(SAMPLE_TEXT.hinglish["EC2 instance"])}</p>
          <p class="hint">Written by Amazon Bedrock from the facts above</p>
        </div>`],
      ["Clean up", "Switched off, safely",
        "A dry run checks permissions first. Nothing changes until you confirm, and anything that holds data is never touched.",
        `<ol class="card mini steps-mini">
          <li><span class="dot-ok">${ICON.check}</span><span>Dry run passed <span class="hint">· nothing changed</span></span></li>
          <li><span class="dot-ok">${ICON.check}</span><span>You confirmed <span class="hint">· stop UbuntuSrever</span></span></li>
          <li><span class="dot-ok">${ICON.check}</span><span>Stopped <span class="hint">· disk kept</span></span></li>
          <li class="saved-row"><span>Saving from today</span><strong>${rupees(ubuntu.usd_per_day)} a day</strong></li>
        </ol>`],
    ];
    return `
      <section class="section" id="features">
        <div class="wrap">
          <div class="section-head reveal">
            <h2>Everything a scan gives you</h2>
            <p>Five things, from one read-only scan.</p>
          </div>
          <div class="card-stack">
            ${panels.map(([label, title, text, visual], i) => `
              <article class="panel-h stack-card" style="--i:${i}">
                <div class="panel-copy">
                  <p class="panel-label">${String(i + 1).padStart(2, "0")} · ${label}</p><h3>${title}</h3><p>${text}</p>
                </div>
                <div class="panel-visual">${visual}</div>
              </article>`).join("")}
          </div>
        </div>
      </section>`;
  }

  function marquee(label, items, seconds, reverse = false) {
    const tiles = (hidden) => items.map(([icon, name]) => `
      <li class="tile"${hidden ? ' aria-hidden="true"' : ""}>
        <img src="icons/${icon}.svg" alt="" width="36" height="36"><span>${name}</span>
      </li>`).join("");
    return `
      <div class="marquee${reverse ? " reverse" : ""}" style="--duration:${seconds}s">
        <span class="marquee-label">${label}</span>
        <div class="marquee-viewport">
          <ul class="marquee-track" aria-label="${label}">${tiles(false)}${tiles(true)}</ul>
        </div>
      </div>`;
  }

  function landingPage() {
    const [ctaHref, ctaLabel] = connected() ? ["#/app", "Open dashboard"] : ["#/connect", "Scan my account"];
    const ctaIcon = connected() ? "" : ICON.scan;
    return `
      <section class="wrap hero">
        <div class="hero-copy">
          <p class="prompt rise" style="--i:0" aria-hidden="true"><span class="sigil">$</span>cloudkavach scan --every-region<span class="caret"></span></p>
          <h1 class="rise" style="--i:1" tabindex="-1" data-autofocus>Somewhere in your AWS account, a server is <span class="burn">still running</span>.</h1>
          <p class="lead rise" style="--i:2">I found two of mine in Stockholm, costing ₹1,336 a month. CloudKavach checks every
            region of your account, prices what is running in rupees, explains it in plain language, and helps you switch it off safely.</p>
          <div class="row rise" style="--i:3">
            <a class="btn btn-primary btn-lg pill" href="${ctaHref}">${ctaIcon}${ctaLabel}</a>
            <button class="btn btn-secondary btn-lg pill" data-action="scroll-to" data-target="how">How it works</button>
          </div>
          <ul class="hero-points rise" style="--i:4"><li>Read-only scan</li><li>Cleanup only if you allow it</li><li>Free</li></ul>
        </div>
        <div class="hero-art">${receiptCard()}</div>
      </section>

      <section class="marquees" aria-label="What CloudKavach checks">
        ${marquee("Checks", WATCHES, 36)}
      </section>

      <section class="section" id="how">
        <div class="wrap">
          <div class="section-head reveal">
            <h2>From your account to a leak report in under a minute</h2>
            <p>Connect once and scan whenever you like. You get what is quietly billing you, what switching it off
              saves, and how sure CloudKavach is about each one.</p>
          </div>
          <ol class="pipeline reveal">
            <li class="stage">
              <div class="stage-visual stage-account" aria-hidden="true">
                ${ACCOUNT_SCATTER.map(([icon, region], k) => `
                  <span class="res-dot" style="--k:${k}"><img src="icons/${icon}.svg" alt="" width="34" height="34"><span>${region}</span></span>`).join("")}
              </div>
              <h3>Your AWS account</h3>
              <p>Connect once with a read-only role. Nothing to install and nothing to sign up for.</p>
            </li>
            <li class="pipe" aria-hidden="true"><span></span><span></span><span></span></li>
            <li class="stage">
              <div class="stage-visual stage-scan" aria-hidden="true">
                <span class="radar">${ICON.brand}</span>
                <span class="scan-label">every region · in parallel</span>
              </div>
              <h3>Kavach scan</h3>
              <p>Every enabled region is checked at once. Each resource is priced and checked for signs of use.</p>
            </li>
            <li class="pipe" aria-hidden="true"><span></span><span></span><span></span></li>
            <li class="stage">
              <div class="stage-visual stage-report" aria-hidden="true">
                ${[0, 1, 3].map((i) => SAMPLE_REPORT.findings[i]).map((f) => `
                  <div class="report-row">
                    <img src="${iconFor(f.kind)}" alt="" width="22" height="22">
                    <span class="report-name"><span>${esc(f.kind)}</span>${verdictChip(f)}</span>
                    <span class="amt">${rupees(f.usd_per_month)}</span>
                  </div>`).join("")}
                <p class="report-total"><span>Potential savings</span>
                  <strong>${rupees(perMonth([0, 1, 3].map((i) => SAMPLE_REPORT.findings[i])))} / mo</strong></p>
              </div>
              <h3>Your leak report</h3>
              <p>What to switch off, what it saves, and why it was flagged, in English, Hinglish or Hindi.</p>
            </li>
          </ol>
        </div>
      </section>

      ${featuresSection()}

      <section class="section" id="compare">
        <div class="wrap">
          <div class="section-head reveal">
            <h2>AWS tools tell you later. CloudKavach tells you now.</h2>
            <p>The built-in tools are made for finance teams watching trends. CloudKavach is made for the student
              who needs to know what is running today.</p>
          </div>
          <div class="table-wrap reveal">
            <table class="matrix">
              <thead>
                <tr>
                  <th scope="col"><span class="visually-hidden">Capability</span></th>
                  ${TOOLS.map(([name, sub], i) => `<th scope="col"${i === 0 ? ' class="us"' : ""}>${name}${sub ? `<span class="sub">${sub}</span>` : ""}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                ${MATRIX.map(([question, cells]) => `
                  <tr>
                    <th scope="row">${question}</th>
                    ${cells.map(([mark, note], i) => `
                      <td${i === 0 ? ' class="us"' : ""}><div class="cell">${MARK[mark]}${note ? `<span class="note">${note}</span>` : ""}</div></td>`).join("")}
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="section" id="security">
        <div class="wrap">
          <div class="section-head reveal">
            <h2>Two separate roles, and the second one is your call</h2>
            <p>Scanning and cleaning up never share permissions. The scan role can't change anything, and the
              cleanup role only exists if you ask for it. Here is everything each one can do.</p>
          </div>
          <div class="roles reveal">
            <div class="roles-root"><span class="brand-chip">${ICON.brand}CloudKavach</span></div>
            <div class="perm-grid">
              <div class="card perm">
                <h3><span class="perm-badge ok">${ICON.check}</span>Scan role<span class="chip">Always</span></h3>
                <p>Read-only. Lists resources and reads their usage metrics.</p>
                <code class="role-name">CloudKavachAccess</code>
                <ul class="perm-list api">${SCAN_PERMISSIONS.map((p) => `<li>${p}</li>`).join("")}</ul>
              </div>
              <div class="card perm">
                <h3><span class="perm-badge warn">${ICON.power}</span>Cleanup role<span class="chip chip-muted">Only if you allow it</span></h3>
                <p>Created only when you set <code>AllowCleanup</code> to <code>true</code>. Every action runs a dry run
                  first and waits for your confirmation.</p>
                <code class="role-name">CloudKavachCleanup</code>
                <ul class="perm-list api">${CLEANUP_PERMISSIONS.map((p) => `<li>${p}</li>`).join("")}</ul>
              </div>
            </div>
            <div class="card never">
              <h3><span class="perm-badge no">${ICON.cross}</span>Neither role can</h3>
              <ul class="never-list">${NEVER.map((n) => `<li>${n}</li>`).join("")}</ul>
              <p class="hint">Both roles are locked to CloudKavach with an ExternalId, a secret only you and CloudKavach
                share. There is no sign-up or password, and scans delete themselves after 7 days.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="closing">
        <div class="wrap reveal">
          <h2>What is your account spending right now?</h2>
          <p>Find out in about a minute. Read-only, no sign-up.</p>
          <a class="btn btn-primary btn-lg pill" href="${ctaHref}">${ctaIcon}${ctaLabel}</a>
        </div>
      </section>`;
  }

  // Highlights the navigation link for the section in the middle of the screen, and slides the
  // underline beneath it. Back at the hero, nothing is highlighted.
  let spy = null;
  function watchSections() {
    spy?.disconnect();
    const links = [...root.querySelectorAll("[data-spy]")];
    const indicator = root.querySelector(".nav-indicator");
    if (!links.length || !("IntersectionObserver" in window)) return;
    const activate = (id) => {
      links.forEach((link) => {
        const current = link.dataset.spy === id;
        if (current) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
        if (current && indicator) {
          indicator.style.width = `${link.offsetWidth - 24}px`;
          indicator.style.transform = `translateX(${link.offsetLeft + 12}px)`;
        }
      });
      if (indicator) indicator.style.opacity = id ? "1" : "0";
    };
    spy = new IntersectionObserver((entries) => {
      entries.filter((entry) => entry.isIntersecting).forEach((entry) => activate(entry.target.id || null));
    }, { rootMargin: "-45% 0px -50% 0px" });
    const hero = root.querySelector(".hero");
    if (hero) spy.observe(hero);
    links.forEach((link) => {
      const section = document.getElementById(link.dataset.spy);
      if (section) spy.observe(section);
    });
  }

  const markScrolled = () => document.querySelector(".site-header")?.classList.toggle("is-scrolled", window.scrollY > 8);

  // Landing page motion, all driven by scroll position:
  //  - the hero copy and the bill drift at different speeds (parallax)
  //  - feature cards stick and stack; each one shrinks and dims as the next covers it
  //  - the "Explain" card cycles English → Hinglish → Hindi
  // Cards still stack for reduced-motion users (the user drives it), just without the extra effects.
  let stopMotion = null;
  function setupLandingMotion() {
    stopMotion?.();
    if (REDUCED_MOTION) return;
    const hero = root.querySelector(".hero");
    const cards = [...root.querySelectorAll(".stack-card")];
    let frame = 0;

    const update = () => {
      frame = 0;
      hero?.style.setProperty("--sy", Math.min(window.scrollY, 1200).toFixed(0));
      cards.forEach((card, i) => {
        const next = cards[i + 1];
        let cover = 0;
        if (next) {
          // How far the next card has slid over this one: 0 = not at all, 1 = fully covered.
          const top = card.getBoundingClientRect().top;
          cover = (top + card.offsetHeight - next.getBoundingClientRect().top) / card.offsetHeight;
          cover = Math.max(0, Math.min(1, cover));
        }
        card.style.setProperty("--cover", cover.toFixed(3));
      });
    };

    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    const onResize = onScroll;

    const langCard = root.querySelector("[data-lang-demo]");
    const order = ["en", "hinglish", "hi"];
    let langIndex = 1;
    const langTimer = langCard ? setInterval(() => {
      const text = langCard.querySelector("[data-lang-text]");
      langIndex = (langIndex + 1) % order.length;
      const lang = order[langIndex];
      text.classList.add("fading");
      setTimeout(() => {
        text.textContent = SAMPLE_TEXT[lang]["EC2 instance"];
        if (lang === "hi") text.setAttribute("lang", "hi");
        else text.removeAttribute("lang");
        langCard.querySelectorAll("[data-lang-tab]").forEach((tab) => tab.classList.toggle("on", tab.dataset.langTab === lang));
        text.classList.remove("fading");
      }, 250);
    }, 2800) : 0;

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    stopMotion = () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
      clearInterval(langTimer);
      stopMotion = null;
    };
  }

  function connectPage() {
    const c = state.connection;
    let launch;
    if (!c) {
      launch = `<button class="btn btn-secondary" disabled>${state.creating ? "Preparing your setup…" : "Open AWS CloudFormation"}</button>`;
    } else if (PREVIEW) {
      launch = `<button class="btn btn-secondary" disabled>Open AWS CloudFormation</button>
        <span class="hint">In the live app this opens your AWS console.</span>`;
    } else {
      launch = `<a class="btn btn-secondary" href="${esc(c.launchUrl)}" target="_blank" rel="noopener noreferrer">
        Open AWS CloudFormation <span aria-hidden="true">↗</span></a>`;
    }
    const setupFailed = !c && state.error;
    return `
      <div class="wizard">
        <h1 tabindex="-1" data-autofocus>Connect your AWS account</h1>
        <p class="lead">You create a read-only role inside your own account, so access always stays under your control.</p>
        ${setupFailed ? `${notice(state.error)}<div class="row"><button class="btn btn-secondary btn-sm" data-action="retry-connection">Try again</button></div>` : ""}
        <ol class="steps">
          <li class="card step">
            <img src="icons/cloudformation.svg" alt="" width="40" height="40">
            <div>
              <h2><span class="num">1</span>Create the access role</h2>
              <ul>
                <li>Creates <code>CloudKavachAccess</code>, a read-only role that lists resources and reads their usage metrics.
                  It can't read your data or change anything.</li>
                <li>Want one-click cleanup? Set <code>AllowCleanup</code> to <code>true</code>. That also creates a separate
                  <code>CloudKavachCleanup</code> role with four specific actions.</li>
                <li>Tick the IAM acknowledgement at the bottom, then choose <strong>Create stack</strong>.</li>
              </ul>
              <div class="row">${launch}</div>
              <p class="hint">Connected before? Delete the old <code>CloudKavachAccess</code> stack first. Every connection
                gets a new secret key, so an old stack can't be reused and a second one fails with "already exists".</p>
            </div>
          </li>
          <li class="card step">
            <img src="icons/iam.svg" alt="" width="40" height="40">
            <div>
              <h2><span class="num">2</span>Paste the role ARN</h2>
              <p class="hint">When the stack shows <code>CREATE_COMPLETE</code>, open its <strong>Outputs</strong> tab and copy <code>RoleArn</code>.</p>
              <form class="field" data-form="verify" novalidate>
                <label for="role-arn">Role ARN</label>
                <div class="row">
                  <input id="role-arn" class="input" autocomplete="off" spellcheck="false"
                    placeholder="${SAMPLE_ARN}" value="${esc(state.roleArn)}">
                  <button class="btn btn-primary" id="verify" type="submit" ${state.busy || !c ? "disabled" : ""}>
                    ${state.busy ? "Checking…" : `${ICON.scan}Verify and scan`}</button>
                </div>
              </form>
              ${c ? notice(state.error) : ""}
            </div>
          </li>
        </ol>
        <p class="hint">To revoke access later, delete the <code>CloudKavachAccess</code> stack in CloudFormation.</p>
      </div>`;
  }

  // ---------- App pages ----------

  function appShell(r) {
    const count = state.scan ? active().length : null;
    const nav = [
      ["overview", "#/app", "Overview", ICON.overview, ""],
      ["resources", "#/app/resources", "Resources", ICON.resources, count === null ? "" : `<span class="count">${count}</span>`],
      ["account", "#/app/account", "Account", ICON.account, ""],
    ];
    let status = "";
    if (state.scanning) status = `<span>Scanning · <span data-elapsed>${elapsed()}</span></span>`;
    else if (state.scan) status = `<span>Last scan ${ago(state.scan.finished_at)}</span>`;
    const pages = { overview: overviewPage, resources: resourcesPage, account: accountPage };
    return `
      <div class="shell">
        <aside class="sidebar">
          <a class="brand" href="#/">${ICON.brand}<span>CloudKavach</span></a>
          <nav class="nav" aria-label="Main">
            ${nav.map(([page, href, label, icon, extra]) => `<a href="${href}"${r.page === page ? ' aria-current="page"' : ""}>${icon}<span>${label}</span>${extra}</a>`).join("")}
          </nav>
          <div class="sidebar-foot">
            <span>AWS account</span>
            <span class="mono">${esc(maskAccount(state.connection.accountId))}</span>
          </div>
        </aside>
        <div class="app-main">
          <header class="topbar">
            <div class="topbar-inner">
              <h1 class="page-title" tabindex="-1" data-autofocus>${TITLES[r.page]}</h1>
              <div class="topbar-right">
                ${status}
                <button class="btn btn-primary btn-sm" id="scan" data-action="scan" ${state.scanning ? "disabled" : ""}>
                  ${ICON.scan}${state.scanning ? "Scanning…" : state.scan ? "Scan again" : "Scan now"}</button>
              </div>
            </div>
          </header>
          <main class="page">${pages[r.page]()}</main>
        </div>
      </div>
      ${r.page === "resources" && r.item ? drawer(r.item) : ""}`;
  }

  function kpi(label, value, note, level = "") {
    return `
      <div class="kpi${level ? ` is-${level}` : ""}">
        <p class="kpi-label">${label}</p>
        <p class="kpi-value">${value}</p>
        <p class="hint">${note}</p>
      </div>`;
  }

  function runwayHtml() {
    const credits = parseFloat(state.credits);
    const live = active();
    const spend = perDay(live);
    if (!(credits > 0)) return `<p>Enter the credits left on your account to see how long they will last.</p>`;
    if (spend <= 0) return `<p>Nothing found is spending your credits right now.</p>`;
    const days = credits / spend;
    const fixable = live.filter((f) => f.action);
    const after = spend - perDay(fixable);
    let html = `<p>At today's rate: <strong class="${days < 30 ? "is-short" : ""}">${howLong(days)}</strong></p>`;
    if (fixable.length) {
      const outcome = after > 0.001 ? `<strong>${howLong(credits / after)}</strong>` : "<strong>until something new starts</strong>";
      html += `<p>After switching off ${fixable.length}: ${outcome}</p>`;
    }
    return html;
  }

  function overviewPage() {
    if (!state.scan) return state.scanning ? scanningCard() : firstScanCard();

    const report = state.scan.report;
    const all = findings();
    const live = active();
    const spend = perDay(live);
    const cut = perDay(all) - spend;
    const regions = byRegion(live);
    const savings = perMonth(potential(live));
    const likely = live.filter((f) => f.verdict === "likely_forgotten").length;
    const level = live.length ? severity(spend) : "ok";
    const max = regions[0]?.[1] || 1;

    const topCosts = live.length
      ? `<ul class="top-list">${live.slice(0, 3).map((f) => `
          <li><a href="${esc(hrefFor(f))}">
            <span class="day sev-text-${severity(f.usd_per_day)}">${rupees(f.usd_per_day)}<span class="per"> /day</span></span>
            ${awsIcon(f.kind, 28)}
            <span class="stack"><span class="kind">${esc(f.kind)}</span><span class="hint">${esc(f.name || f.id)} · ${esc(regionName(f.region))}</span></span>
            ${verdictChip(f)}
            ${ICON.chevron}
          </a></li>`).join("")}</ul>`
      : `<p class="panel-body hint">Nothing billable is running.</p>`;

    const regionBars = regions.length
      ? `<ul class="bars">${regions.map(([code, usd]) => `
          <li>
            <span>${esc(regionName(code))} <span class="mono">${esc(code)}</span></span>
            <span class="bar" aria-hidden="true"><span style="width:${Math.max(2, (usd / max) * 100).toFixed(1)}%"></span></span>
            <span class="bar-value">${rupees(usd)}</span>
          </li>`).join("")}</ul>`
      : `<p class="hint">No region is spending right now.</p>`;

    return `
      ${state.scanning ? scanningCard() : ""}
      ${notice(state.scanError)}
      ${cut > 0 ? notice(`You've cut ${rupees(cut)} a day since this scan.`, "ok") : ""}
      <section class="card summary" aria-label="Summary">
        ${kpi("Spending per day", rupees(spend), live.length ? `${rupees(perMonth(live))} a month` : "Nothing billable is running", level)}
        ${kpi("Potential savings", `${rupees(savings)}<span class="kpi-unit"> / mo</span>`, `${rupees(savings * 12)} a year`, savings > 0 ? "ok" : "")}
        ${kpi("Likely forgotten", `${likely}<span class="kpi-unit"> of ${live.length}</span>`, regions.length ? `Spending in ${plural(regions.length, "region")}` : "Every region is clear")}
      </section>
      <div class="grid-2">
        <section class="card panel">
          <div class="panel-head"><h2>Top costs</h2><a class="link-sm" href="#/app/resources">View all ${all.length}</a></div>
          ${topCosts}
        </section>
        <section class="card panel runway">
          <div class="panel-head"><h2>Credits runway</h2></div>
          <div class="panel-body">
            <div>
              <label for="credits">Credits left on your account</label>
              <div class="money-input">
                <span aria-hidden="true">$</span>
                <input id="credits" class="input" inputmode="decimal" autocomplete="off" placeholder="100" value="${esc(state.credits)}">
              </div>
            </div>
            <div id="runway" aria-live="polite">${runwayHtml()}</div>
          </div>
        </section>
      </div>
      <section class="card panel">
        <div class="panel-head"><h2>Spend by region</h2><span class="hint">Per day</span></div>
        <div class="panel-body">${regionBars}</div>
      </section>`;
  }

  function resourceRow(f) {
    const key = keyOf(f);
    const status = isDone(f) ? `<span class="chip chip-ok">${ACTIONS[f.action].done}</span>` : verdictChip(f);
    return `
      <tr class="clickable sev-${severity(f.usd_per_day)}${isDone(f) ? " is-done" : ""}" data-href="${esc(hrefFor(f))}">
        <td class="cost stack">
          <span class="day">${f.estimated ? '<span class="approx" title="Estimated price">≈</span>' : ""}${rupees(f.usd_per_day)}</span>
          <span class="month">${rupees(f.usd_per_month)} / mo</span>
        </td>
        <td>
          <span class="res">${awsIcon(f.kind, 30)}
            <span class="stack"><span>${esc(f.kind)}</span><span class="hint">${esc(detailLine(f))}</span></span>
          </span>
        </td>
        <td class="stack"><span>${esc(regionName(f.region))}</span><span class="mono">${esc(f.region)}</span></td>
        <td class="stack cell-id">
          <a class="row-link" id="row:${esc(key)}" href="${esc(hrefFor(f))}">${esc(f.name || "Unnamed")}</a>
          <span class="mono" title="${esc(f.id)}">${esc(f.id)}</span>
        </td>
        <td>${status}</td>
        <td class="chev" aria-hidden="true">${ICON.chevron}</td>
      </tr>`;
  }

  function resourcesPage() {
    if (!state.scan) return state.scanning ? scanningCard() : firstScanCard();
    const all = findings();
    const errors = state.scan.report.errors || [];
    if (!all.length) {
      return `<section class="card empty-state"><h2>All clear</h2>
        <p>Nothing billable is running in any of the ${state.scan.report.regions_scanned.length} regions CloudKavach checked.</p></section>`;
    }
    const tabs = FILTERS
      .map(([id, label, test]) => ({ id, label, count: all.filter(test).length }))
      .filter((t) => t.id === "all" || t.count > 0 || state.filter === t.id);
    const test = (FILTERS.find(([id]) => id === state.filter) || FILTERS[0])[2];
    const rows = all.filter(test);
    return `
      ${state.scanning ? scanningCard() : ""}
      ${notice(state.scanError)}
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Filter resources">
          ${tabs.map((t) => `<button id="filter:${t.id}" data-action="filter" data-filter="${t.id}"
            aria-pressed="${state.filter === t.id}">${t.label}<span class="count">${t.count}</span></button>`).join("")}
        </div>
        <span class="hint">Sorted by cost. Prices are on-demand estimates, not your invoice.</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th class="num">Per day</th><th>Resource</th><th>Region</th><th>Name / ID</th><th>Assessment</th>
              <th><span class="visually-hidden">Open</span></th></tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map(resourceRow).join("") : `<tr><td colspan="6" class="hint">Nothing matches this filter.</td></tr>`}
          </tbody>
        </table>
      </div>
      ${errors.length ? `<p class="footnote">${plural(errors.length, "check")} couldn't run, so a few resources may be missing.
        For example: ${esc(errors[0].check.replace(/_/g, " "))} in ${esc(regionName(errors[0].region))}.</p>` : ""}`;
  }

  function accountPage() {
    const c = state.connection;
    return `
      <section class="card panel">
        <div class="panel-head"><h2>Connected account</h2></div>
        <div class="panel-body">
          <dl class="meta-list">
            <dt>Account ID</dt><dd class="mono">${esc(c.accountId)}</dd>
            <dt>Connected</dt><dd>${esc(fmtDate(c.connectedAt) || "Unknown")}</dd>
            <dt>Scan role</dt>
            <dd><code>CloudKavachAccess</code>, read-only. Lists resources and reads their usage metrics.</dd>
            <dt>Cleanup role</dt>
            <dd><code>CloudKavachCleanup</code>, only if you set <code>AllowCleanup</code> to <code>true</code>.
              Stops instances and databases, releases idle IPs and deletes NAT Gateways, each after your confirmation.</dd>
          </dl>
        </div>
      </section>
      <section class="card panel">
        <div class="panel-head"><h2>Revoke access</h2></div>
        <div class="panel-body">
          <p>The access role lives in your account, so you can remove it any time: delete the <code>CloudKavachAccess</code>
            stack in CloudFormation. CloudKavach can't see anything after that.</p>
          <div class="row">
            <a class="btn btn-secondary btn-sm" href="https://console.aws.amazon.com/cloudformation/home#/stacks"
              target="_blank" rel="noopener noreferrer">Open CloudFormation <span aria-hidden="true">↗</span></a>
            <button class="btn btn-secondary btn-sm" data-action="disconnect">Disconnect this browser</button>
          </div>
          <p class="hint">Disconnecting only forgets the connection in this browser. Delete the stack to remove access
            completely, and before you connect again: the next connection needs a fresh stack.</p>
        </div>
      </section>`;
  }

  // ---------- Drawer ----------

  function explanationHtml(f) {
    const key = keyOf(f);
    const entry = state.explanations[`${key}|${state.lang}`];
    if (!entry || entry.status === "loading") return `<p class="hint">Asking Amazon Bedrock…</p>`;
    if (entry.status === "error") {
      return `${notice(entry.error)}<button class="btn-link" data-action="explain-retry" data-key="${esc(key)}">Try again</button>`;
    }
    const source = {
      bedrock: "Written by Amazon Bedrock from the facts above",
      builtin: "Built-in explanation (Amazon Bedrock was unavailable)",
      sample: "Sample explanation",
    }[entry.source] || "";
    return `<p class="explain-text"${state.lang === "hi" ? ' lang="hi"' : ""}>${esc(entry.text)}</p><p class="hint">${source}</p>`;
  }

  function cleanupHtml(f) {
    const key = keyOf(f);
    if (isDone(f)) return notice(state.scan.cleaned[key], "ok");
    if (!f.action) {
      return `<p class="muted-p">CloudKavach won't remove this automatically, because deleting it can destroy data.
        Check it in the AWS console first.</p>`;
    }
    const action = ACTIONS[f.action];
    const c = state.cleanups[key];
    const effect = `<p class="muted-p">${action.effect}</p>`;
    if (!c) {
      return `${effect}
        <div class="row">
          <button class="btn btn-secondary btn-sm" id="check:${esc(key)}" data-action="cleanup-check" data-key="${esc(key)}">${action.verb}…</button>
          <span class="hint">Runs a dry run first</span>
        </div>`;
    }
    if (c.status === "checking") return `${effect}<p class="hint">Running a dry run…</p>`;
    if (c.status === "error") {
      return `${notice(c.message)}<button class="btn-link" data-action="cleanup-cancel" data-key="${esc(key)}">Start over</button>`;
    }
    const running = c.status === "running";
    return `${effect}
      <div class="row" role="group" aria-label="Confirm cleanup">
        <span class="chip chip-ok">${ICON.check}Dry run passed</span>
        <span class="hint">Nothing has changed yet.</span>
      </div>
      <div class="row">
        <button class="btn btn-${action.style} btn-sm" id="confirm:${esc(key)}" data-action="cleanup-confirm"
          data-key="${esc(key)}" ${running ? "disabled" : ""}>${running ? "Working…" : action.verb}</button>
        <button class="btn btn-secondary btn-sm" data-action="cleanup-cancel" data-key="${esc(key)}"
          ${running ? "disabled" : ""}>Cancel</button>
      </div>`;
  }

  // Resource details open in a wide modal: understand on the left, act on the right.
  function drawer(key) {
    const f = findByKey(key);
    if (!f) return "";
    const detail = detailLine(f);
    const since = f.details?.launched || f.details?.created;
    const reasons = f.reasons?.length
      ? `<ul class="why-list">${f.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>`
      : `<p class="hint">No usage data was available for this resource.</p>`;
    const saving = POTENTIAL.includes(f.verdict)
      ? `<p class="saving">Potential saving: <strong>${rupees(f.usd_per_month)} a month</strong>, ${rupees((f.usd_per_month || 0) * 12)} a year</p>`
      : `<p class="hint">It looks like it's in use, so it isn't counted as a potential saving.</p>`;
    return `
      <div class="scrim" data-action="close-drawer"></div>
      <div class="modal modal-resource" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header class="modal-head">
          <div class="modal-title">
            ${awsIcon(f.kind, 40)}
            <div>
              <p class="eyebrow">${esc(f.kind)} · ${esc(regionName(f.region))}</p>
              <h2 id="drawer-title" tabindex="-1">${esc(f.name || "Unnamed")}</h2>
            </div>
          </div>
          <div class="modal-cost${isDone(f) ? " is-done" : ""}">
            <span><span class="amt-main${isDone(f) ? "" : ` sev-text-${severity(f.usd_per_day)}`}">${f.estimated ? "≈" : ""}${rupees(f.usd_per_day)}</span><span class="unit"> a day</span></span>
            <span class="hint">${rupees(f.usd_per_month)} a month</span>
          </div>
          <button class="icon-btn" data-action="close-drawer" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="modal-body">
          <div class="modal-col">
            <section class="drawer-section">
              <div class="section-title"><h3>Why am I seeing this?</h3>${verdictChip(f)}</div>
              ${reasons}
              ${saving}
            </section>
            <section class="drawer-section">
              <h3>Details</h3>
              <dl class="meta-list compact">
                <dt>Region</dt><dd>${esc(regionName(f.region))} <span class="mono">${esc(f.region)}</span></dd>
                <dt>Resource ID</dt><dd class="mono">${esc(f.id)}</dd>
                ${detail ? `<dt>Details</dt><dd>${esc(detail)}</dd>` : ""}
                ${since ? `<dt>${f.details?.launched ? "Running since" : "Created"}</dt><dd>${esc(fmtDate(since))}</dd>` : ""}
              </dl>
            </section>
          </div>
          <div class="modal-col modal-col-act">
            <section class="drawer-section">
              <div class="section-title"><h3>What is this?</h3>${langSwitch()}</div>
              ${explanationHtml(f)}
            </section>
            <section class="drawer-section">
              <h3>Clean up</h3>
              ${cleanupHtml(f)}
            </section>
          </div>
        </div>
        <footer class="modal-foot">
          <a class="btn btn-secondary btn-sm" href="${esc(consoleUrl(f))}" target="_blank" rel="noopener noreferrer">
            Open in AWS console <span aria-hidden="true">↗</span></a>
        </footer>
      </div>`;
  }

  // Shown once, when someone first clicks "Scan my account": the trust promise before connecting.
  let promiseSeen = false;
  let promiseTrigger = null;

  function promiseModal() {
    const points = [
      ["key", "No password, no access keys", "You never type your AWS password or keys into CloudKavach, so there is nothing for us to lose."],
      ["eye", "Read-only by default", "You create a role in your own account that can only list resources and read their usage."],
      ["undo", "Revoke in one step", "Delete the CloudFormation stack and access ends immediately."],
      ["user", "No sign-up", "No email and no account. Scans delete themselves after 7 days."],
    ];
    return `
      <div class="scrim promise-layer" data-action="promise-close"></div>
      <div class="modal modal-promise promise-layer" role="dialog" aria-modal="true" aria-labelledby="promise-title">
        <div class="promise-body">
          <span class="promise-mark">${ICON.brand}</span>
          <h2 id="promise-title" tabindex="-1">CloudKavach never asks for your password</h2>
          <p class="lead">Instead of logging in as you, it uses a read-only role that you create and control,
            the same way AWS partner tools connect to customer accounts.</p>
          <ul class="promise-list">
            ${points.map(([icon, title, text]) => `
              <li><span class="p-icon">${ICON[icon]}</span><div><h3>${title}</h3><p>${text}</p></div></li>`).join("")}
          </ul>
        </div>
        <footer class="modal-foot">
          <button class="btn btn-secondary" data-action="promise-close">Not now</button>
          <button class="btn btn-primary" data-action="promise-continue">${ICON.scan}Continue to connect</button>
        </footer>
      </div>`;
  }

  function openPromise(trigger) {
    if (root.querySelector(".modal-promise")) return;
    promiseTrigger = trigger;
    root.insertAdjacentHTML("beforeend", promiseModal());
    document.body.classList.add("has-drawer");
    document.getElementById("promise-title")?.focus({ preventScroll: true });
  }

  function closePromise() {
    root.querySelectorAll(".promise-layer").forEach((el) => el.remove());
    document.body.classList.remove("has-drawer");
    promiseTrigger?.focus({ preventScroll: true });
    promiseTrigger = null;
  }

  // ---------- Render ----------

  const root = document.getElementById("root");
  let last = { page: null, item: null };
  let pendingScroll = null;

  function scrollToSection(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "start" });
  }

  function render() {
    const r = route();
    const inApp = r.page === "overview" || r.page === "resources" || r.page === "account";
    if (inApp && !connected()) { location.replace("#/connect"); return; }
    if (r.page === "connect" && connected()) { location.replace("#/app"); return; }

    const focused = document.activeElement;
    const before = {
      focusedId: focused && root.contains(focused) ? focused.id : "",
      selection: focused && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null,
      drawerScroll: root.querySelector(".modal-body")?.scrollTop || 0,
    };

    if (r.page === "landing") root.innerHTML = siteLayout(landingPage());
    else if (r.page === "connect") root.innerHTML = siteLayout(connectPage(), true);
    else root.innerHTML = appShell(r);

    const item = r.item && findByKey(r.item) ? r.item : null;
    document.body.classList.toggle("has-drawer", Boolean(item));
    document.title = inApp ? `${TITLES[r.page]} · CloudKavach` : "CloudKavach";

    if (r.page !== last.page) {
      window.scrollTo(0, 0);
      if (last.page !== null) root.querySelector("[data-autofocus]")?.focus({ preventScroll: true });
    } else if (item && item !== last.item) {
      document.getElementById("drawer-title")?.focus({ preventScroll: true });
    } else if (!item && last.item) {
      document.getElementById(`row:${last.item}`)?.focus({ preventScroll: true });
    } else {
      const el = before.focusedId && document.getElementById(before.focusedId);
      if (el && !el.disabled) {
        el.focus({ preventScroll: true });
        if (before.selection && el.setSelectionRange) {
          try { el.setSelectionRange(before.selection[0], before.selection[1]); } catch { /* not a text field */ }
        }
      }
      const body = root.querySelector(".modal-body");
      if (body) body.scrollTop = before.drawerScroll;
    }
    last = { page: r.page, item };

    markScrolled();
    if (r.page === "landing") {
      watchSections();
      setupLandingMotion();
      if (pendingScroll) { scrollToSection(pendingScroll); pendingScroll = null; }
    } else {
      spy?.disconnect();
      stopMotion?.();
    }
    if (r.page === "connect" && !state.connection && !state.creating && !state.error) queueMicrotask(createConnection);
    if (item && !state.explanations[`${item}|${state.lang}`]) queueMicrotask(() => loadExplanation(item));
  }

  // ---------- Actions ----------

  async function createConnection() {
    if (state.creating) return;
    state.creating = true;
    state.error = null;
    render();
    try {
      const c = await api.createConnection();
      state.connection = { connectionId: c.connectionId, key: c.key, launchUrl: c.launchUrl, status: "pending" };
      persistConnection();
    } catch (e) {
      state.error = e.message;
    }
    state.creating = false;
    render();
  }

  async function verify() {
    const roleArn = state.roleArn.trim();
    if (!ROLE_ARN.test(roleArn)) {
      state.error = "That doesn't look like the CloudKavachAccess role. The ARN should end in role/CloudKavachAccess.";
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    render();
    try {
      const result = await api.verify(roleArn);
      Object.assign(state.connection, { status: "connected", accountId: result.accountId, connectedAt: new Date().toISOString() });
      persistConnection();
      state.busy = false;
      go("#/app");
      runScan();
      return;
    } catch (e) {
      state.error = e.message;
    }
    state.busy = false;
    render();
  }

  async function runScan() {
    if (state.scanning) return;
    state.scanning = true;
    state.scanError = null;
    state.scanStartedAt = Date.now();
    render();
    try {
      const { scanId } = await api.startScan();
      let scan;
      do {
        await sleep(2000);
        scan = await api.getScan(scanId);
      } while (scan.status === "running" && Date.now() - state.scanStartedAt < 180000);
      if (scan.status !== "done") throw new Error(scan.error || "The scan is taking longer than expected. Try again in a minute.");
      state.scan = { scanId, finished_at: scan.finished_at, report: scan.report, cleaned: {} };
      state.explanations = {};
      state.cleanups = {};
      persistScan();
    } catch (e) {
      state.scanError = e.message;
    }
    state.scanning = false;
    render();
  }

  async function loadExplanation(key) {
    const language = state.lang;
    const cacheKey = `${key}|${language}`;
    const f = findByKey(key);
    const cached = state.explanations[cacheKey];
    if (!f || (cached && cached.status !== "error")) return;
    state.explanations[cacheKey] = { status: "loading" };
    render();
    try {
      const result = await api.explain(f, language);
      state.explanations[cacheKey] = { status: "done", text: result.text, source: result.source };
    } catch (e) {
      state.explanations[cacheKey] = { status: "error", error: e.message };
    }
    render();
  }

  async function checkCleanup(key) {
    const f = findByKey(key);
    if (!f) return;
    state.cleanups[key] = { status: "checking" };
    render();
    try {
      const result = await api.cleanup(f, true);
      state.cleanups[key] = { status: "confirm", message: result.message };
    } catch (e) {
      state.cleanups[key] = { status: "error", message: e.message };
    }
    render();
  }

  async function confirmCleanup(key) {
    const f = findByKey(key);
    if (!f) return;
    state.cleanups[key] = { ...state.cleanups[key], status: "running" };
    render();
    try {
      const result = await api.cleanup(f, false);
      state.scan.cleaned = { ...(state.scan.cleaned || {}), [key]: result.message };
      delete state.cleanups[key];
      persistScan();
    } catch (e) {
      state.cleanups[key] = { status: "error", message: e.message };
    }
    render();
  }

  function disconnect() {
    saved.remove(STORE.connection);
    saved.remove(STORE.scan);
    Object.assign(state, {
      connection: null, scan: null, error: null, scanError: null,
      explanations: {}, cleanups: {}, roleArn: PREVIEW ? SAMPLE_ARN : "",
    });
    go("#/");
  }

  const closeDrawer = () => go("#/app/resources");

  // ---------- Events ----------

  document.addEventListener("click", (event) => {
    const toConnect = event.target.closest('a[href="#/connect"]');
    if (toConnect && route().page === "landing" && !promiseSeen && !connected()) {
      event.preventDefault();
      openPromise(toConnect);
      return;
    }
    const el = event.target.closest("[data-action]");
    if (el) {
      if (el.disabled) return;
      const key = el.dataset.key;
      const handlers = {
        "scan": runScan,
        "retry-connection": () => { state.error = null; createConnection(); },
        "scroll-to": () => {
          if (route().page === "landing") scrollToSection(el.dataset.target);
          else { pendingScroll = el.dataset.target; go("#/"); }
        },
        "filter": () => { state.filter = el.dataset.filter; render(); },
        "lang": () => { state.lang = el.dataset.lang; render(); },
        "explain-retry": () => { delete state.explanations[`${key}|${state.lang}`]; loadExplanation(key); },
        "close-drawer": closeDrawer,
        "cleanup-check": () => checkCleanup(key),
        "cleanup-confirm": () => confirmCleanup(key),
        "cleanup-cancel": () => { delete state.cleanups[key]; render(); },
        "disconnect": disconnect,
        "promise-close": closePromise,
        "promise-continue": () => { promiseSeen = true; promiseTrigger = null; closePromise(); go("#/connect"); },
      };
      handlers[el.dataset.action]?.();
      return;
    }
    const row = event.target.closest("tr[data-href]");
    if (row && !event.target.closest("a, button")) go(row.dataset.href);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (root.querySelector(".modal-promise")) closePromise();
    else if (document.body.classList.contains("has-drawer")) closeDrawer();
  });

  document.addEventListener("submit", (event) => {
    if (event.target.dataset.form !== "verify") return;
    event.preventDefault();
    verify();
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "role-arn") state.roleArn = event.target.value;
    if (event.target.id === "credits") {
      state.credits = event.target.value;
      if (!PREVIEW) saved.write(STORE.credits, state.credits);
      document.getElementById("runway").innerHTML = runwayHtml();
    }
  });

  setInterval(() => {
    if (!state.scanning) return;
    document.querySelectorAll("[data-elapsed]").forEach((el) => { el.textContent = elapsed(); });
  }, 1000);

  window.addEventListener("scroll", markScrolled, { passive: true });
  window.addEventListener("hashchange", render);
  document.getElementById("preview-banner").hidden = !PREVIEW;
  if (!location.hash) history.replaceState(null, "", "#/");
  render();
})();
