"use strict";
// Labs hub: one page that lists every lab with its topic, level and the course and guide that go with it.
module.exports = function ({ html, UI, esc }) {
  const G = [
    { h: "Core sandbox", items: [
      ["/labs", "Payment Labs", "Beginner", "A sandbox gateway with a real API: payments, declines, 3-D Secure, webhooks, disputes, settlement.", "card-payments", "getting-started"],
      ["/labs/controls", "Card controls and idempotency", "Intermediate", "Spending controls, retries and duplicate protection.", "api-security", "idempotency-and-retries"],
      ["/labs/tokens", "Tokenization", "Intermediate", "Swap card numbers for tokens and see what each one can do.", "tokenization", "tokenization"],
    ] },
    { h: "Risk and fraud", items: [
      ["/labs/risk", "Risk engine", "Intermediate", "Score payments, set thresholds and weigh approvals against fraud.", "fraud-and-risk", "risk-and-fraud"],
      ["/labs/evidence", "Dispute evidence pack", "Intermediate", "Build an evidence pack for a chargeback, get it scored and see the ruling.", "disputes", "chargeback-defence-and-evidence"],
      ["/labs/kpis", "Payment KPIs", "Intermediate", "Authorisation rate, fraud rate, chargeback ratio and what moves them.", "ecommerce-risk-ops", "ecommerce-fraud-schemes"],
    ] },
    { h: "Cards in the real world", items: [
      ["/labs/acquiring", "POS acquiring and certification", "Advanced", "Terminals, chip decisions and certification tests.", "pos-acquiring", "pos-acquiring-and-certification"],
      ["/labs/terminal", "Terminal messaging", "Advanced", "Authorisation, reversal, void, tip adjustment and batch close.", "terminal-messaging", "terminal-messages-and-batches"],
      ["/labs/issuer", "Wallet provisioning, issuer view", "Advanced", "How an issuer decides whether to add a card to a phone.", "tokenization", "wallet-provisioning-issuer-view"],
      ["/labs/agents", "Agent payments", "Advanced", "Let an AI agent pay within mandates and limits.", "ai-in-payments", "agentic-payments"],
    ] },
    { h: "Money movement", items: [
      ["/labs/fees", "Fees", "Intermediate", "Build an interchange fee and compare pricing models.", "fees-clearing-reconciliation", "how-interchange-and-fees-work"],
      ["/labs/clearing", "Clearing and reconciliation", "Intermediate", "Send clearing files, read the settlement advice and reconcile it.", "fees-clearing-reconciliation", "clearing-settlement-advice-and-reconciliation"],
    ] },
    { h: "Beyond cards", items: [
      ["/labs/qr", "QR payments", "Beginner", "Build and take apart a QR payment code and judge seven scans.", "qr-payments", "how-qr-payments-work"],
      ["/labs/transfers", "Account-to-account transfers", "Intermediate", "Batch and instant bank transfers, direct debit and transfer scams.", "account-to-account-payments", "account-to-account-payments"],
      ["/labs/ussd", "USSD mobile money", "Beginner", "A feature-phone menu, agents, lost replies and SIM swap.", "ussd-mobile-money", "ussd-and-mobile-money"],
    ] },
  ];
  const card = (x) => `<a class="panel lab" href="${x[0]}"><span class="lvl">${esc(x[2])}</span><strong>${esc(x[1])}</strong><span class="d">${esc(x[3])}</span><span class="rel">Course: <u>${esc(x[4].replace(/-/g, " "))}</u></span></a>`;
  function page() {
    const body = `<style>.lab{display:flex;flex-direction:column;gap:6px;text-decoration:none;color:inherit}.lab:hover{border-color:var(--accent,#3b6cff)}.lab .lvl{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute,#5b6478)}.lab .d{color:var(--mute,#5b6478);font-size:15px}.lab .rel{font-size:13px;color:var(--mute,#5b6478)}.lab strong{font-size:18px}.lab .rel u{display:inline-block;text-decoration:none}.lab .rel u::first-letter{text-transform:uppercase}</style><div class="wrap"><h1>All labs</h1>
<p class="lede">Every lab on Zanboxx in one place. Each is a safe simulation with test data only, and each has a course and a guide that explain what you are seeing. New here? Start with the core sandbox, then follow the topic you care about.</p>
${G.map((g) => `<h2>${esc(g.h)}</h2><div class="grid">${g.items.map(card).join("")}</div>`).join("")}
<p class="hint">Courses are on the <a href="/academy">Academy</a> and guides in the <a href="/knowledge">Knowledge Centre</a>. Every lab links to its own course and guide at the bottom of the page.</p></div>`;
    return UI.shell({ title: "All labs – Zanboxx", description: "Every Zanboxx lab in one place, with its level and the course and guide that go with it.", active: "labs", body });
  }
  return { async handle(req, res, path, m) { if (m === "GET" && path === "/labs/all") { html(res, 200, page()); return true; } return false; } };
};
