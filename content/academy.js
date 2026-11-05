"use strict";
// Academy courses: original lessons, quizzes with answer keys (server side only) and tasks checked against the learner's own sandbox activity.
const ok = (p) => p.transaction_state === "success";
const has = (acc, f) => (acc.payments || []).some(f);
const T = (id, text, hint, check) => ({ id, text, hint, check });
const Q = (q, options, answer, why) => ({ q, options, answer, why });

module.exports = [
  { id: "card-payments", title: "Card payments fundamentals", level: "Beginner", minutes: 45, summary: "Who is involved in a card payment, how authorisation, capture and refunds work, and how to read a decline.",
    lessons: [
      { title: "The four parties", md: "A card payment involves a **cardholder**, a **merchant**, the merchant's bank (the **acquirer**) and the cardholder's bank (the **issuer**). The **card scheme** (Visa, Mastercard, American Express) connects the banks and sets the rules.\n\nThe merchant never talks to the issuer directly. The request goes merchant, acquirer, scheme, issuer, and the answer comes back the same way, usually in under two seconds.\n\nAmerican Express often acts as both issuer and acquirer, which is why it is called a *three-party* scheme." },
      { title: "Authorise, capture, refund, void", md: "An **authorisation** asks the issuer if the payment is allowed and reserves the money. A **capture** collects it. A **purchase** does both at once.\n\nUse authorise-then-capture when the final amount or the shipping date is not known at checkout. A **void** cancels before the payment clears. A **refund** returns money after.\n\nA refund cannot be larger than what was captured, minus earlier refunds. A capture can be smaller than the authorisation but not larger." },
      { title: "Reading a decline", md: "A decline comes with a response code. The same reason has different codes on different schemes: *insufficient funds* is `51` on Visa and Mastercard but `116` on American Express.\n\nSome declines are **hard** (do not honour, invalid card: never retry) and some are **soft** (insufficient funds: a later retry may work). Retrying a hard decline repeatedly can get a merchant flagged.\n\nTell the customer something useful without leaking detail: \"your card was declined, try another card\" is better than a raw code." },
      { title: "Idempotency and timeouts", md: "The network can fail after the issuer approved but before your system heard back. If you simply retry, you may charge twice.\n\nSend a unique **idempotency key** (`request_id`) with every payment. A retry with the same key returns the original result instead of creating a second payment.\n\nOn a timeout, do not assume failure: look the payment up, or wait for the webhook, before you retry with a new key." },
    ],
    quiz: [
      Q("Which party decides whether a payment is approved?", ["The acquirer", "The card scheme", "The issuer", "The merchant"], 2, "The issuer holds the cardholder's account, so it approves or declines. The scheme only carries the messages."),
      Q("A hotel reserves 300.00 at check-in and charges 240.00 at check-out. Which flow fits?", ["Purchase, then refund 60.00", "Authorisation, then a capture of 240.00", "Two purchases", "Void, then a purchase"], 1, "Authorise the larger amount, then capture what was really used."),
      Q("What does an idempotency key prevent?", ["Declines", "Duplicate charges when a request is retried", "Chargebacks", "Slow responses"], 1, "The same key returns the original result instead of creating a new payment."),
      Q("Which decline should you NOT retry automatically?", ["Insufficient funds", "Do not honour", "Gateway timeout", "Issuer unavailable"], 1, "Do not honour is a hard decline; the issuer will not approve this card."),
      Q("When can you void instead of refund?", ["After settlement", "Before the transaction clears", "Only for declined payments", "Never"], 1, "A void cancels before clearing, so no money moves and fees are usually avoided."),
    ],
    tasks: [
      T("approve", "Create an approved card payment.", "Use the test card 4111 1111 1111 1111 in Payment Labs.", (a) => has(a, (p) => p.transaction_type === "purchase" && ok(p))),
      T("decline", "Create a declined payment.", "Use 4000 0000 0000 0002.", (a) => has(a, (p) => p.transaction_type === "purchase" && p.transaction_state === "failed")),
      T("capture", "Authorise a payment, then capture it.", "Create an authorisation, then a capture-authorization with its transaction id.", (a) => has(a, (p) => p.transaction_type === "capture-authorization" && ok(p))),
      T("refund", "Refund part of a payment.", "Create a refund with parent_transaction_id and a smaller amount.", (a) => has(a, (p) => p.transaction_type === "refund" && ok(p))),
    ] },
  { id: "three-d-secure", title: "3-D Secure and strong authentication", level: "Beginner", minutes: 40, summary: "Why online payments are authenticated, the frictionless and challenge flows, ECI values and liability shift.",
    lessons: [
      { title: "Why 3-D Secure exists", md: "Online card payments have no chip and no PIN, so fraud is easier. **3-D Secure** adds a step where the issuer checks the buyer is the real cardholder.\n\nIn Europe, **strong customer authentication (SCA)** under PSD2 requires two of three factors (something you know, have or are) for most online payments. 3-D Secure is how merchants meet it." },
      { title: "Frictionless and challenge", md: "The merchant sends the issuer data about the buyer and the device. If the issuer sees low risk, it approves silently: a **frictionless** flow. If not, it asks the buyer to prove themselves with a code or an app approval: a **challenge**.\n\nThe result is a status: `Y` authenticated, `A` attempted, `N` denied, `U` unavailable, `R` rejected, `C` challenge required." },
      { title: "ECI and liability shift", md: "The **ECI** (electronic commerce indicator) records how well the payment was authenticated. Visa and American Express use `05` for full authentication, `06` for attempted; Mastercard uses `02` and `01`.\n\nWhen a payment is fully authenticated, **liability for fraud chargebacks shifts to the issuer**. That is the main business reason to use 3-D Secure." },
      { title: "Handling the outcomes", md: "Plan for every outcome: authenticated (continue), challenge (wait for the buyer), denied (do not charge), unavailable (decide your risk policy), rejected (do not retry).\n\nBuyers abandon challenges, so use exemptions and frictionless flows where the rules allow." },
    ],
    quiz: [
      Q("What does liability shift mean?", ["Fees move to the issuer", "Responsibility for fraud claims moves to the issuer", "The acquirer pays the customer", "The scheme refunds the merchant"], 1, "With full authentication, fraud chargebacks are the issuer's responsibility."),
      Q("Which ECI means a fully authenticated Mastercard payment?", ["05", "06", "02", "07"], 2, "Mastercard uses 02 for full authentication and 01 for attempted."),
      Q("A frictionless flow means...", ["The buyer typed a code", "The issuer approved authentication without asking the buyer", "The payment skipped authentication", "The payment was refunded"], 1, "Low-risk payments are authenticated silently."),
      Q("Status R means...", ["Retry later", "The issuer rejected authentication: do not retry", "Required by law", "Refund issued"], 1, "R is a rejection; do not retry the same card."),
      Q("SCA requires...", ["A PIN on every payment", "Two of three factors for most online payments", "A signature", "Chip only"], 1, "Knowledge, possession or inherence: two of the three."),
    ],
    tasks: [
      T("frictionless", "Run a frictionless 3-D Secure payment.", "Use 4000 0000 0000 3000 (status Y).", (a) => has(a, (p) => p.authentication && p.authentication.trans_status === "Y")),
      T("challenge", "Complete a 3-D Secure challenge.", "Use 4000 0000 0000 3220 and finish the challenge in the lab.", (a) => has(a, (p) => p.authentication && p.authentication.trans_status === "Y" && p.scheme === "visa" && p.card_last4 === "3220")),
      T("denied", "Produce a denied authentication.", "Use 4000 0000 0000 3238 (status N).", (a) => has(a, (p) => p.authentication && p.authentication.trans_status === "N")),
    ] },
  { id: "disputes", title: "Disputes and chargebacks", level: "Intermediate", minutes: 45, summary: "How chargebacks start, what evidence wins, and how to respond before the deadline.",
    lessons: [
      { title: "How a chargeback starts", md: "The cardholder tells their bank they do not recognise or accept a charge. The issuer raises a dispute through the scheme, the money is **withdrawn from the merchant**, and the merchant has a short time to respond.\n\nA chargeback costs the amount plus usually a fee, and too many can lead to monitoring programmes or losing the ability to take cards." },
      { title: "Reason codes and categories", md: "Each scheme has its own reason codes, but they fall into a few families: **fraud**, **goods or services not received**, **not as described**, and **duplicate processing**.\n\nThe category decides what evidence helps: delivery proof for not-received, the order and customer messages for not-as-described, both charges' references for duplicates." },
      { title: "Evidence that wins", md: "Respond once, completely, and before the deadline. For fraud, show the customer is the real one: IP, email, device, earlier orders. For not-received, give the carrier tracking number and proof of delivery.\n\nA missed deadline is a loss, whatever the facts." },
      { title: "Prevention", md: "Use 3-D Secure (liability shifts for fraud), clear descriptors on statements, fast refunds for unhappy customers, and keep delivery records. A customer who gets a quick refund does not call the bank." },
    ],
    quiz: [
      Q("What happens to the money when a dispute is raised?", ["Nothing until it is decided", "It is withdrawn from the merchant while the dispute is open", "The customer keeps both", "It is held by the scheme forever"], 1, "The amount is pulled back right away and returned only if the merchant wins."),
      Q("Which evidence fits a 'not received' dispute?", ["Customer IP address", "Carrier tracking number and proof of delivery", "Refund policy", "3-D Secure result"], 1, "Delivery proof answers the claim."),
      Q("What happens if you miss the response deadline?", ["Extension", "The dispute is lost", "It is won", "The customer is refunded by the scheme only"], 1, "Deadlines are strict."),
      Q("Why does 3-D Secure help against fraud disputes?", ["It prevents all declines", "Liability for fraud moves to the issuer", "It is cheaper", "It hides the customer"], 1, "Authenticated payments shift fraud liability."),
      Q("Can you submit evidence more than once?", ["Yes, unlimited", "No: once, so make it complete", "Only on Fridays", "Only for refunds"], 1, "Evidence is submitted once."),
    ],
    tasks: [
      T("raise", "Raise a dispute on a successful card payment.", "Use the Disputes section in Payment Labs.", (a) => (a.disputes || []).length > 0),
      T("evidence", "Submit evidence on a dispute.", "Send the required fields for the category.", (a) => (a.disputes || []).some((d) => d.evidence_submitted_at)),
      T("won", "Win a dispute.", "Send complete evidence, or choose a win outcome.", (a) => (a.disputes || []).some((d) => d.state === "won")),
    ] },
  { id: "recurring", title: "Subscriptions and merchant-initiated payments", level: "Intermediate", minutes: 35, summary: "Storing a card, customer- versus merchant-initiated payments, network transaction IDs and retry rules.",
    lessons: [
      { title: "CIT and MIT", md: "A **customer-initiated transaction (CIT)** is one the customer starts and takes part in. A **merchant-initiated transaction (MIT)** is started later by the merchant under an agreement, such as a monthly renewal.\n\nThe first payment is a CIT with the customer's consent to store the card. Every later charge is an MIT that points back to it." },
      { title: "The agreement and the network transaction ID", md: "The scheme returns a **network transaction ID** for the first payment. Later MITs quote it so the issuer knows they belong to an agreement the customer approved.\n\nWithout it, issuers are more likely to decline, and customers are more likely to dispute." },
      { title: "Types of agreements", md: "**Recurring** (a subscription with no fixed end), **instalment** (a fixed number of payments) and **unscheduled** (when the customer's usage triggers a charge, for example a top-up).\n\nStore only what you need, tell the customer, and make cancelling easy." },
      { title: "Retrying failed renewals", md: "Follow the scheme's advice: never retry a hard decline; retry later for insufficient funds, within the scheme's limits; ask for new details when a card has expired. Notify the customer before their account is cancelled." },
    ],
    quiz: [
      Q("The first payment in a subscription is...", ["An MIT", "A CIT with consent to store the card", "A refund", "An authorisation only"], 1, "The customer takes part and agrees to the agreement."),
      Q("What does the network transaction ID do?", ["Identifies the merchant", "Links later MITs to the first approved payment", "Is the card number", "Is the PIN"], 1, "It proves the MIT belongs to an agreement."),
      Q("Which agreement has a fixed number of payments?", ["Recurring", "Instalment", "Unscheduled", "Refund"], 1, "Instalments end after the agreed count."),
      Q("After a hard decline on a renewal, you should...", ["Retry every hour", "Not retry; ask for another payment method", "Retry with a new key", "Ignore it"], 1, "Do not retry a hard decline."),
      Q("An expired card on a renewal needs...", ["Nothing", "New card details or an account update", "A refund", "A void"], 1, "Fix the credentials before retrying."),
    ],
    tasks: [
      T("store", "Store a card for later payments.", "Make a payment with store_credential, in the Card on file section.", (a) => (a.agreements || []).length > 0),
      T("mit", "Charge a merchant-initiated payment against an agreement.", "Send initiator merchant and the agreement id.", (a) => has(a, (p) => p.initiator === "merchant" && ok(p))),
    ] },
  { id: "settlement", title: "Clearing, settlement and reconciliation", level: "Intermediate", minutes: 50, summary: "How the day's payments become a payout, where the fees go, and how to find the missing money.",
    lessons: [
      { title: "Clearing versus settlement", md: "**Clearing** is the exchange of transaction details between acquirer and issuer. **Settlement** is the actual money movement between banks. The acquirer then **pays out** to the merchant, normally net of fees, a day or more later.\n\nBecause of this gap, the money you see in a dashboard is not the money in your bank." },
      { title: "What is in the payout", md: "A payout is: sales, minus refunds, minus chargebacks, minus fees, plus reversals. Disputes pull money out before they are decided; wins put it back.\n\nA payout rarely equals a single day's sales, which is why reconciliation is a job." },
      { title: "Where the fee goes", md: "On a card payment the merchant's fee splits into **interchange** (to the issuer), a **scheme fee** (to the network) and the **acquirer's markup**. With **blended** pricing the merchant pays one flat rate; with **interchange++** each cost is passed through plus a fixed markup.\n\nWhich is cheaper depends on your card mix: consumer debit is cheap, commercial and international cards are not." },
      { title: "Reconciliation", md: "Match your orders and refunds against the settlement report line by line. Typical differences: timing (late-night sales settle tomorrow), a refund that settles in a different batch, fees, chargebacks, and rounding.\n\nAutomate it, and investigate every difference you cannot explain." },
    ],
    quiz: [
      Q("Which is true of clearing and settlement?", ["They are the same", "Clearing exchanges transaction data; settlement moves the money", "Settlement happens before authorisation", "Clearing is only for refunds"], 1, "Data first, money after."),
      Q("Who receives interchange?", ["The card scheme", "The acquirer", "The issuer", "The merchant"], 2, "The acquirer pays it to the issuer."),
      Q("Blended pricing means...", ["Each cost is shown separately", "One flat rate for everything", "No fees", "Fees paid by the issuer"], 1, "One rate hides the real costs."),
      Q("A payout is smaller than yesterday's sales. A likely reason?", ["A bug is the only reason", "Refunds, chargebacks and fees were deducted", "The bank is closed", "The scheme kept it"], 1, "Payouts are net."),
      Q("What is reconciliation?", ["Refunding customers", "Matching your records against the settlement report", "Closing an account", "Blocking a card"], 1, "It finds missing, extra and different items."),
    ],
    tasks: [
      T("close", "Close a settlement day.", "Use the Settlement section, or POST /v1/settlements.", (a) => (a.settlements || []).length > 0),
      T("reconcile", "Reconcile your ledger against a batch.", "Use the checker in the Settlement section.", (a) => (a.settlements || []).some((s) => s.reconciled_at || s.reconciliation)),
    ] },
  { id: "card-present", title: "Chip, stripe, POS and ATM", level: "Advanced", minutes: 60, summary: "How chip cards sign transactions, why stripes are weak, and how PINs and cryptograms are checked.",
    lessons: [
      { title: "Magnetic stripe and its weakness", md: "The stripe holds static data. Anyone who reads it can copy it onto another card, which is why counterfeiting was easy.\n\nA three-digit **service code** on the stripe tells the terminal whether the card has a chip (first digit 2 or 6) and whether it needs a PIN. A chip card swiped on a stripe reader is refused." },
      { title: "The chip and the cryptogram", md: "A chip card computes a **cryptogram** (ARQC) over the transaction data: amount, currency, date, a random number from the terminal and its own transaction counter. The key is unique to the card and to that counter.\n\nThe issuer recomputes it. If anything differs, the transaction is declined. A copied card number is no use without the chip." },
      { title: "Counters and replays", md: "Each transaction has a higher **application transaction counter (ATC)**. A recorded cryptogram replayed later carries an old counter and is caught. The terminal's random number and the amount are also signed, so they cannot be changed afterwards." },
      { title: "PINs", md: "The PIN is entered on an encrypted PIN pad and travels as an **encrypted PIN block**, mixed with the card number so the same PIN looks different on every card. The issuer checks a **PIN verification value**; it never stores the PIN. Three wrong tries block the card for PIN use." },
      { title: "POS and ATM transaction types", md: "POS: sale, pre-authorisation, completion, incremental authorisation, void, reversal, refund, cashback, cash advance, quasi-cash, OCT and AFT. ATM: withdrawal, balance, mini statement, PIN change.\n\nA **reversal** undoes a transaction the terminal could not complete, so the customer is not charged for a failed read." },
    ],
    quiz: [
      Q("Why is a chip transaction harder to counterfeit than a stripe?", ["It is faster", "The chip signs each transaction with a key that never leaves it", "It needs a signature", "It uses Wi-Fi"], 1, "A copied number cannot produce a valid cryptogram."),
      Q("A recorded cryptogram is replayed. What catches it?", ["The PIN", "An application transaction counter that did not increase", "The terminal ID", "The currency"], 1, "The ATC rises with each transaction."),
      Q("A chip card is swiped on a stripe reader. The service code starts with 2. Result?", ["Approved", "Refused: use the chip", "Refunded", "Blocked for ever"], 1, "Service code 2xx or 6xx means use the chip."),
      Q("What does the issuer store to check a PIN?", ["The PIN", "A PIN verification value", "The card number only", "The PIN block"], 1, "It never stores the PIN."),
      Q("What is a reversal for?", ["Returning goods", "Undoing a transaction the terminal could not complete", "Raising an authorisation", "Changing a PIN"], 1, "It protects the customer from a failed transaction."),
    ],
    tasks: [
      T("chip", "Approve a chip sale.", "Use the EMV lab with a test card.", (a) => has(a, (p) => p.cp && p.cp.entry_mode === "chip" && ok(p))),
      T("tamper", "See a tampered cryptogram declined.", "Pick 'Flip a bit of the cryptogram' in the EMV lab.", (a) => has(a, (p) => p.cp && p.cp.response_code === "82" && p.transaction_state === "failed")),
      T("atm", "Withdraw cash at an ATM with a PIN.", "Use the ATM channel and the test PIN 1234.", (a) => has(a, (p) => p.cp && p.cp.channel === "atm" && p.cp.transaction_type === "withdrawal" && ok(p))),
    ] },
];
