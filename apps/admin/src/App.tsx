import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  Award,
  BookOpenCheck,
  ChevronRight,
  CircleGauge,
  Coffee,
  CreditCard,
  Database,
  Gift,
  LayoutDashboard,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
  WalletCards,
  X
} from "lucide-react";
import {
  Badge,
  CommandButton,
  EmptyState,
  IconButton,
  SearchInput,
  Section,
  SelectField,
  Spinner
} from "./components/ui/index.js";
import { formatDate, formatNumber, memberName, percentage } from "./format.js";
import type {
  AdminMember,
  AdminSnapshot,
  LedgerEntry,
  LedgerOperation,
  ProgramModelId,
  ProgramModelStatus
} from "./types.js";

type View = "overview" | "members" | "ledger" | "program" | "developer";

const navigation: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "members", label: "Members", icon: Users },
  { id: "ledger", label: "Ledger", icon: BookOpenCheck },
  { id: "program", label: "Configure", icon: Settings2 },
  { id: "developer", label: "API", icon: Database }
];

const modelIcons: Record<ProgramModelId, typeof Gift> = {
  points: Award,
  visits: Coffee,
  wallet_credit: CreditCard,
  paid_membership: ShieldCheck,
  hybrid: Sparkles
};

function displayProgramName(program: AdminSnapshot["program"]): string {
  if (program.program_id === "demo-foodservice") return "Main Loyalty Program";
  return program.name;
}

function metric(member: AdminMember, id: string): number {
  return member.metrics.find((candidate) => candidate.metric_id === id)?.amount ?? 0;
}

function operationLabel(operation: LedgerOperation): string {
  return operation.replace("_", " ");
}

function OperationBadge({ operation }: { operation: LedgerOperation }) {
  return <Badge className={`operation operation-${operation}`}>{operationLabel(operation)}</Badge>;
}

function TierBadge({ tier }: { tier: string | undefined }) {
  return <Badge className={`tier tier-${tier ?? "none"}`}>{tier ?? "None"}</Badge>;
}

function statusTone(status: ProgramModelStatus): "success" | "info" | "muted" {
  if (status === "active") return "success";
  if (status === "available") return "info";
  return "muted";
}

function memberSubtitle(member: AdminMember["member"]): string {
  if (typeof member.attributes?.email === "string") return member.attributes.email;
  return member.member_id.replace(/^demo-member-/, "customer-");
}

function Login({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState("lip-dev-key");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/admin/api/v1/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey })
      });
      if (!response.ok) throw new Error("The API key was not accepted.");
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand-mark"><CircleGauge size={24} aria-hidden="true" /></div>
        <p className="product-label">Loyalty dashboard</p>
        <h1 id="login-title">Sign in to your workspace</h1>
        <form onSubmit={submit}>
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            name="api-key"
            type="password"
            autoComplete="current-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <CommandButton
            disabled={submitting}
            icon={<LogIn size={17} aria-hidden="true" />}
            type="submit"
          >
            {submitting ? "Signing in" : "Sign in"}
          </CommandButton>
        </form>
        <p className="login-meta">Local workspace · Admin API 0.1</p>
      </section>
    </main>
  );
}

function Stat({ label, value, detail, icon: Icon }: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <article className="stat-card">
      <div className="stat-heading"><Icon size={17} aria-hidden="true" /><span>{label}</span></div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function LedgerTable({ entries, members, limit }: {
  entries: LedgerEntry[];
  members: AdminMember[];
  limit?: number;
}) {
  const visible = limit ? entries.slice(0, limit) : entries;
  if (visible.length === 0) return <EmptyState>No ledger entries match this view.</EmptyState>;
  const profiles = new Map(members.map((member) => [member.member.member_id, member.member]));
  return (
    <div className="table-scroll">
      <table className="ledger-table">
        <thead><tr><th>Operation</th><th>Member</th><th className="reference-column">Reference</th><th className="date-column">Date</th><th className="numeric">Points</th></tr></thead>
        <tbody>
          {visible.map((entry) => (
            <tr key={entry.entry_id}>
              <td><OperationBadge operation={entry.operation} /></td>
              <td>
                <span className="primary-cell">{profiles.get(entry.member_id) ? memberName(profiles.get(entry.member_id)?.attributes, entry.member_id) : entry.member_id}</span>
                <code>{profiles.get(entry.member_id) ? memberSubtitle(profiles.get(entry.member_id)!) : entry.member_id}</code>
              </td>
              <td className="reference-column"><code>{entry.order_id ?? entry.adjustment_id ?? entry.reservation_id ?? entry.related_entry_id ?? entry.entry_id}</code></td>
              <td className="date-column">{formatDate(entry.occurred_at, true)}</td>
              <td className={`numeric amount ${entry.amount >= 0 ? "positive" : "negative"}`}>{entry.amount >= 0 ? "+" : ""}{formatNumber(entry.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ snapshot, onViewMembers }: { snapshot: AdminSnapshot; onViewMembers: () => void }) {
  const tiers = snapshot.program.tiers.map((tier) => ({
    ...tier,
    count: snapshot.members.filter((member) => member.member.tier_id === tier.tier_id).length
  }));
  const maximum = Math.max(...tiers.map((tier) => tier.count), 1);
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Dashboard</p><h2>Loyalty overview</h2></div></div>
      <section className="stats-grid" aria-label="Program totals">
        <Stat label="Active members" value={formatNumber(snapshot.summary.active_members)} detail="Enrolled accounts" icon={Users} />
        <Stat label="Outstanding" value={formatNumber(snapshot.summary.points_outstanding)} detail="Posted points" icon={WalletCards} />
        <Stat label="Issued" value={formatNumber(snapshot.summary.points_issued)} detail="Positive ledger value" icon={Activity} />
        <Stat label="Redeemed" value={formatNumber(snapshot.summary.points_redeemed)} detail={`${formatNumber(snapshot.summary.expiring_points)} still expiring`} icon={Gift} />
      </section>
      <div className="overview-grid">
        <Section className="tier-distribution" heading="Tier distribution" description="Current annual qualification">
          <div className="tier-bars">
            {tiers.map((tier) => (
              <div className="tier-bar-row" key={tier.tier_id}>
                <div><TierBadge tier={tier.tier_id} /><span>{tier.count}</span></div>
                <div className="bar-track"><span style={{ width: `${Math.max((tier.count / maximum) * 100, tier.count ? 8 : 0)}%` }} /></div>
              </div>
            ))}
          </div>
        </Section>
        <Section className="expiration-panel" heading="Point expiration" description="Earned-date policy">
          <div className="expiration-value"><strong>{snapshot.program.point_expiration?.days ?? "—"}</strong><span>days</span></div>
          <dl className="compact-definition">
            <div><dt>Warnings</dt><dd>{snapshot.program.point_expiration?.warning_days.join(", ") ?? "None"} days</dd></div>
            <div><dt>Scheduled</dt><dd>{formatNumber(snapshot.summary.expiring_points)} points</dd></div>
          </dl>
        </Section>
      </div>
      <Section
        action={<CommandButton icon={<ChevronRight size={15} aria-hidden="true" />} onClick={onViewMembers} variant="text">View members</CommandButton>}
        description={`${formatNumber(snapshot.summary.ledger_entries)} total entries`}
        heading="Recent activity"
      >
        <LedgerTable entries={snapshot.ledger} members={snapshot.members} limit={6} />
      </Section>
    </>
  );
}

function MemberDetail({ member, onClose }: { member: AdminMember; onClose: () => void }) {
  const qualifying = metric(member, "tier-qualifying");
  return (
    <aside className="member-detail" aria-label="Member details">
      <div className="detail-heading">
        <div><p className="eyebrow">Member</p><h3>{memberName(member.member.attributes, member.member.member_id)}</h3><code>{memberSubtitle(member.member)}</code></div>
        <IconButton label="Close member details" onClick={onClose}><X size={18} /></IconButton>
      </div>
      <div className="detail-balance"><span>Available points</span><strong>{formatNumber(member.balance.available)}</strong><TierBadge tier={member.member.tier_id} /></div>
      <dl className="detail-list">
        <div><dt>Status</dt><dd>{member.member.status}</dd></div>
        <div><dt>Joined</dt><dd>{formatDate(member.member.joined_at)}</dd></div>
        <div><dt>Qualifying</dt><dd>{formatNumber(qualifying)} points</dd></div>
        <div><dt>Last activity</dt><dd>{member.last_activity_at ? formatDate(member.last_activity_at, true) : "No activity"}</dd></div>
        <div><dt>Email</dt><dd>{typeof member.member.attributes?.email === "string" ? member.member.attributes.email : "—"}</dd></div>
      </dl>
      <div className="progress-block">
        <div><span>Tier progress</span><strong>{member.tier_progress ? percentage(member.tier_progress.progress_bps) : "—"}</strong></div>
        <div className="progress-track"><span style={{ width: `${(member.tier_progress?.progress_bps ?? 0) / 100}%` }} /></div>
        <small>{member.tier_progress?.is_top_tier ? "Top tier" : `${formatNumber(member.tier_progress?.remaining_to_next ?? 0)} to ${member.tier_progress?.next_tier_id ?? "next tier"}`}</small>
      </div>
      <div className="expiring-list">
        <h4>Expiring balances</h4>
        {member.expiring_balances.length ? member.expiring_balances.map((balance) => (
          <div key={balance.expires_at}><span>{formatDate(balance.expires_at)}</span><strong>{formatNumber(balance.amount)}</strong></div>
        )) : <p>None scheduled</p>}
      </div>
    </aside>
  );
}

function Members({ members }: { members: AdminMember[] }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return members;
    return members.filter(({ member }) =>
      member.member_id.toLowerCase().includes(normalized) ||
      memberName(member.attributes, member.member_id).toLowerCase().includes(normalized) ||
      (typeof member.attributes?.email === "string" && member.attributes.email.toLowerCase().includes(normalized))
    );
  }, [members, query]);
  const selected = members.find(({ member }) => member.member_id === selectedId);

  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Accounts</p><h2>Members</h2></div><span className="record-count">{formatNumber(filtered.length)} records</span></div>
      <div className={`members-layout ${selected ? "has-detail" : ""}`}>
        <Section className="member-list-section">
          <div className="toolbar">
            <SearchInput
              aria-label="Search members"
              icon={<Search size={16} aria-hidden="true" />}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search members"
              value={query}
            />
          </div>
          <div className="table-scroll">
            <table className="member-table">
              <thead><tr><th>Member</th><th>Tier</th><th className="status-column">Status</th><th className="date-column">Last activity</th><th className="numeric">Balance</th></tr></thead>
              <tbody>
                {filtered.map((member) => (
                  <tr className={selectedId === member.member.member_id ? "selected-row" : "clickable-row"} key={member.member.member_id} onClick={() => setSelectedId(member.member.member_id)}>
                    <td><span className="primary-cell">{memberName(member.member.attributes, member.member.member_id)}</span><code>{memberSubtitle(member.member)}</code></td>
                    <td><TierBadge tier={member.member.tier_id} /></td>
                    <td className="status-column"><span className={`status status-${member.member.status}`}>{member.member.status}</span></td>
                    <td className="date-column">{member.last_activity_at ? formatDate(member.last_activity_at, true) : "—"}</td>
                    <td className="numeric amount">{formatNumber(member.balance.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 ? <EmptyState>No members match “{query}”.</EmptyState> : null}
        </Section>
        {selected ? <MemberDetail member={selected} onClose={() => setSelectedId(undefined)} /> : null}
      </div>
    </>
  );
}

function Ledger({ snapshot }: { snapshot: AdminSnapshot }) {
  const [operation, setOperation] = useState<LedgerOperation | "all">("all");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => snapshot.ledger.filter((entry) => {
    if (operation !== "all" && entry.operation !== operation) return false;
    const normalized = query.trim().toLowerCase();
    return !normalized || [entry.member_id, entry.entry_id, entry.order_id, entry.adjustment_id]
      .some((value) => value?.toLowerCase().includes(normalized));
  }), [operation, query, snapshot.ledger]);
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Immutable history</p><h2>Ledger</h2></div><span className="record-count">{formatNumber(filtered.length)} entries</span></div>
      <Section>
        <div className="toolbar ledger-toolbar">
          <SearchInput
            aria-label="Search ledger"
            icon={<Search size={16} aria-hidden="true" />}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search references"
            value={query}
          />
          <SelectField value={operation} onChange={(event) => setOperation(event.target.value as LedgerOperation | "all")} aria-label="Filter by operation">
            <option value="all">All operations</option>
            <option value="accrual">Accrual</option><option value="redemption">Redemption</option><option value="reversal">Reversal</option><option value="adjustment">Adjustment</option><option value="expiration">Expiration</option><option value="manual">Manual</option>
          </SelectField>
        </div>
        <LedgerTable entries={filtered} members={snapshot.members} />
      </Section>
    </>
  );
}

function Program({ snapshot }: { snapshot: AdminSnapshot }) {
  const { program } = snapshot;
  const { program_configuration: configuration } = snapshot;
  const [selectedModel, setSelectedModel] = useState<ProgramModelId>(configuration.current_model_id);
  useEffect(() => {
    setSelectedModel(configuration.current_model_id);
  }, [configuration.current_model_id]);
  const model = configuration.templates.find((candidate) => candidate.model_id === selectedModel) ??
    configuration.templates.find((candidate) => candidate.model_id === configuration.current_model_id) ??
    configuration.templates[0]!;
  const ModelIcon = modelIcons[model.model_id];
  const exclusions = [
    ...program.earning.exclusions.product_ids,
    ...program.earning.exclusions.category_ids,
    ...program.earning.exclusions.tags,
    ...program.earning.exclusions.line_kinds
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Configuration</p>
          <h2>Program builder</h2>
        </div>
        <span className="record-count">Current program · {displayProgramName(program)}</span>
      </div>
      <section className="config-layout">
        <div className="model-picker">
          <div className="model-picker-heading">
            <div>
              <h3>Choose a program model</h3>
              <p>Server-provided templates show what the reference engine supports now and what is still planned.</p>
            </div>
          </div>
          <div className="program-model-grid">
            {configuration.templates.map((candidate) => {
              const Icon = modelIcons[candidate.model_id];
              const active = candidate.model_id === selectedModel;
              return (
                <button
                  className={`program-model ${active ? "active" : ""} model-${candidate.status}`}
                  key={candidate.model_id}
                  onClick={() => setSelectedModel(candidate.model_id)}
                  type="button"
                >
                  <span className="model-icon"><Icon size={17} aria-hidden="true" /></span>
                  <div className="model-title-row">
                    <strong>{candidate.name}</strong>
                    <Badge tone={statusTone(candidate.status)}>{candidate.status}</Badge>
                  </div>
                  <small>{candidate.summary}</small>
                </button>
              );
            })}
          </div>
        </div>
        <aside className="model-summary">
          <span className="reward-icon"><ModelIcon size={18} aria-hidden="true" /></span>
          <p className="eyebrow">Selected model</p>
          <h3>{model.name}</h3>
          <p>{model.summary}</p>
          <dl>
            <div><dt>Status</dt><dd><Badge tone={statusTone(model.status)}>{model.status}</Badge></dd></div>
            <div><dt>Best for</dt><dd>{model.best_for}</dd></div>
            <div><dt>Cadence</dt><dd>{model.cadence}</dd></div>
            <div><dt>Engine support</dt><dd>{model.engine_support}</dd></div>
            <div><dt>Admin writes</dt><dd>{model.admin_write_support}</dd></div>
          </dl>
          <div className="model-notes">
            <h4>{model.blockers.length ? "Implementation blockers" : "Supported now"}</h4>
            <ul>
              {(model.blockers.length ? model.blockers : model.supported_features).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </aside>
      </section>
      <Section heading="Next implementation work" description="Configuration work owned by the reference Admin API">
        <div className="next-action-list">
          {configuration.next_actions.map((action) => <div key={action}><Settings2 size={15} aria-hidden="true" /><span>{action}</span></div>)}
        </div>
      </Section>
      <section className="policy-band">
        <div className="policy-band-heading">
          <h3>Current policy</h3>
          <p>These values are served by the local loyalty engine.</p>
        </div>
        <dl>
          <div><dt>Earn rate</dt><dd>{program.earning.rate.amount} {program.earning.rate.unit} / ${(program.earning.rate.spend.amount / 100).toFixed(2)}</dd></div>
          <div><dt>Minimum check</dt><dd>${(program.earning.minimum_eligible_spend.amount / 100).toFixed(2)}</dd></div>
          <div><dt>Channels</dt><dd>{program.earning.eligible_channels.join(", ")}</dd></div>
          <div><dt>Rounding</dt><dd>{program.earning.rounding.replace("_", " ")}</dd></div>
          <div><dt>Exclusions</dt><dd>{exclusions.length}</dd></div>
          <div><dt>Tier reset</dt><dd>{program.tier_policy?.period.time_zone ?? "Not configured"}</dd></div>
        </dl>
      </section>
      <Section heading="Tiers" description="Annual qualification thresholds">
        <div className="table-scroll"><table><thead><tr><th>Tier</th><th>Threshold</th><th>Earn multiplier</th><th>Benefits</th></tr></thead><tbody>
          {program.tiers.map((tier) => <tr key={tier.tier_id}><td><TierBadge tier={tier.tier_id} /></td><td>{formatNumber(tier.minimum)} points</td><td>{percentage(tier.earn_multiplier_bps ?? 10_000)}</td><td>{tier.benefits.map((benefit) => benefit.name).join(", ") || "—"}</td></tr>)}
        </tbody></table></div>
      </Section>
      <Section heading="Rewards" description={`${program.rewards.length} configured rewards`}>
        <div className="reward-grid">
          {program.rewards.map((reward) => (
            <article className="reward-card" key={reward.reward_id}>
              <div><span className="reward-icon"><Gift size={17} /></span><div><h4>{reward.name}</h4><p>{reward.description ?? reward.effect.type.replace("_", " ")}</p></div></div>
              <strong>{formatNumber(reward.cost.amount)} pts</strong>
              <small>{reward.funding.map((share) => `${share.party_type} ${percentage(share.share_bps)}`).join(" · ")}</small>
            </article>
          ))}
        </div>
      </Section>
    </>
  );
}

function Developer({ snapshot }: { snapshot: AdminSnapshot }) {
  const rows = [
    ["Protocol", snapshot.platform.protocol_version],
    ["Profile", snapshot.platform.profile],
    ["Admin API", snapshot.admin_api_version],
    ["Public API", `${window.location.origin}/lip/v1`],
    ["Discovery", `${window.location.origin}/.well-known/lip`],
    ["Storage driver", snapshot.platform.storage.driver],
    ["Storage location", snapshot.platform.storage.location],
    ["Snapshot generated", formatDate(snapshot.generated_at, true)]
  ];
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">Developer</p><h2>API status</h2></div></div>
      <Section className="developer-status">
        <div className="status-banner"><span className="status-icon"><ShieldCheck size={19} /></span><div><h3>Local API online</h3><p>{snapshot.platform.storage.persistent ? "Durable state enabled" : "Ephemeral state"}</p></div><span className="live-indicator">Healthy</span></div>
        <dl className="developer-list">
          {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
        </dl>
      </Section>
      <Section className="capability-grid">
        <div><Database size={18} /><span>Persistence</span><strong>{snapshot.platform.storage.persistent ? "SQLite WAL" : "Memory"}</strong></div>
        <div><ShieldCheck size={18} /><span>Admin session</span><strong>HttpOnly cookie</strong></div>
        <div><CircleGauge size={18} /><span>Loyalty API</span><strong>11 operations</strong></div>
      </Section>
    </>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<AdminSnapshot>();
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [view, setView] = useState<View>("overview");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/admin/api/v1/snapshot", { credentials: "same-origin" });
      if (response.status === 401) {
        setAuthenticated(false);
        setSnapshot(undefined);
        return;
      }
      if (!response.ok) throw new Error(`Admin API returned HTTP ${response.status}`);
      setSnapshot(await response.json() as AdminSnapshot);
      setAuthenticated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Admin API unavailable");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function logout() {
    await fetch("/admin/api/v1/logout", { method: "POST", credentials: "same-origin" });
    setSnapshot(undefined);
    setAuthenticated(false);
  }

  if (authenticated === undefined && !error) return <main className="loading-page"><Spinner className="loading-mark" /><span>Loading Admin</span></main>;
  if (authenticated === false) return <Login onAuthenticated={refresh} />;
  if (!snapshot) return <main className="loading-page"><p>{error || "Admin data unavailable"}</p><CommandButton icon={<RefreshCw size={16} />} onClick={() => void refresh()}>Retry</CommandButton></main>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><div className="brand-mark"><Store size={21} /></div><div><strong>Loyalty</strong><span>Operations dashboard</span></div></div>
        <nav aria-label="Admin navigation">
          {navigation.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)} title={item.label}><Icon size={17} /><span>{item.label}</span></button>;
          })}
        </nav>
        <div className="sidebar-footer"><span className="environment-dot" />Local workspace · {snapshot.platform.storage.driver}</div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div><strong>{displayProgramName(snapshot.program)}</strong><span>{formatNumber(snapshot.summary.active_members)} active members · {snapshot.platform.storage.driver}</span></div>
          <div className="topbar-actions">
            <span className="updated-at">Updated {formatDate(snapshot.generated_at, true)}</span>
            <IconButton disabled={refreshing} label="Refresh data" onClick={() => void refresh()}><RefreshCw className={refreshing ? "spin" : ""} size={17} /></IconButton>
            <IconButton label="Sign out" onClick={() => void logout()}><LogOut size={17} /></IconButton>
          </div>
        </header>
        {error ? <div className="error-banner" role="alert">{error}</div> : null}
        <main className="main-content">
          {view === "overview" ? <Overview snapshot={snapshot} onViewMembers={() => setView("members")} /> : null}
          {view === "members" ? <Members members={snapshot.members} /> : null}
          {view === "ledger" ? <Ledger snapshot={snapshot} /> : null}
          {view === "program" ? <Program snapshot={snapshot} /> : null}
          {view === "developer" ? <Developer snapshot={snapshot} /> : null}
        </main>
      </div>
    </div>
  );
}
