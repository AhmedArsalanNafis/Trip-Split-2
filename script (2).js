/* =====================================================================
   TripSplit — trip expense splitter
   All data lives in localStorage, namespaced per trip code.
   NOTE ON REAL-WORLD USE: localStorage is per-browser, not a server.
   Two people on two different phones will NOT see each other's entries
   with this file alone — wire the storage functions below to a real
   backend (Firebase, Supabase, a small REST API, etc.) to make trips
   sync across devices. Everything else — the split math, the UI, the
   receipt scanning — plugs straight into that swap.
===================================================================== */

const STORAGE_PREFIX = "tripsplit_trip_";
const SESSION_KEY = "tripsplit_session";
const CURRENCY = "৳";

// ---------- Small helpers ----------

function money(n){
  const v = Math.round((n + Number.EPSILON) * 100) / 100;
  return CURRENCY + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function genTripCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "TRP-";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genId(prefix){
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function initials(name){
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("");
}

function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add("hidden"), 2400);
}

async function copyToClipboard(text, label){
  try{
    await navigator.clipboard.writeText(text);
    showToast(label + " copied");
  } catch{
    showToast(label + ": " + text);
  }
}

// ---------- Trip storage ----------

function loadTrip(tripId){
  const raw = localStorage.getItem(STORAGE_PREFIX + tripId);
  return raw ? JSON.parse(raw) : null;
}

function saveTrip(trip){
  localStorage.setItem(STORAGE_PREFIX + trip.id, JSON.stringify(trip));
}

function createTrip({ tripName, leaderName, leaderPhone, startDate, endDate }){
  let id = genTripCode();
  while (loadTrip(id)) id = genTripCode(); // avoid the rare collision
  const leader = { id: genId("mem"), name: leaderName, phone: leaderPhone, role: "leader", paid: false };
  const trip = {
    id,
    name: tripName,
    createdAt: Date.now(),
    startDate: startDate || null,
    endDate: endDate || null,
    members: [leader],
    expenses: []
  };
  saveTrip(trip);
  return { trip, memberId: leader.id };
}

function joinTrip({ tripId, name, phone }){
  const trip = loadTrip(tripId.trim().toUpperCase());
  if (!trip) return { error: "That trip code doesn't match anything. Double-check it with your trip leader." };
  const existing = trip.members.find(m => m.phone === phone);
  if (existing){
    return { trip, memberId: existing.id }; // rejoining with same phone just resumes their seat
  }
  const member = { id: genId("mem"), name, phone, role: "member", paid: false };
  trip.members.push(member);
  saveTrip(trip);
  return { trip, memberId: member.id };
}

function addExpense(trip, { payerId, desc, amount, fromReceipt }){
  trip.expenses.push({
    id: genId("exp"),
    payerId,
    desc,
    amount: Number(amount),
    time: Date.now(),
    fromReceipt: !!fromReceipt
  });
  // A new expense changes everyone's fair share, so any "paid" mark made
  // against the old total is no longer accurate — reset everyone to pending.
  trip.members.forEach(m => { m.paid = false; });
  saveTrip(trip);
}

function setMemberPaid(trip, memberId, paid){
  const member = trip.members.find(m => m.id === memberId);
  if (!member) return;
  member.paid = paid;
  saveTrip(trip);
}

// ---------- Split math ----------

function tripTotal(trip){
  return trip.expenses.reduce((sum, e) => sum + e.amount, 0);
}

function perPersonShare(trip){
  const n = trip.members.length || 1;
  return tripTotal(trip) / n;
}

function paidByMember(trip, memberId){
  return trip.expenses
    .filter(e => e.payerId === memberId)
    .reduce((sum, e) => sum + e.amount, 0);
}

function balanceForMember(trip, memberId){
  return paidByMember(trip, memberId) - perPersonShare(trip);
}

// ---------- Session ----------

function saveSession(tripId, memberId){
  localStorage.setItem(SESSION_KEY, JSON.stringify({ tripId, memberId }));
}

function getSession(){
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearSession(){
  localStorage.removeItem(SESSION_KEY);
}

// ---------- App state ----------

let currentTrip = null;
let currentMemberId = null;

// ---------- Screen navigation (simple back-stack, no browser history API
// so this behaves the same whether opened as a local file or hosted) ----------

let currentScreen = "role-picker";
let navStack = [];

function showScreen(name, { push = true } = {}){
  if (push && currentScreen && currentScreen !== name) navStack.push(currentScreen);
  document.querySelectorAll(".screen-panel").forEach(el => el.classList.add("hidden"));
  document.getElementById("screen-" + name).classList.remove("hidden");
  currentScreen = name;
}

function goBack(){
  const prev = navStack.pop();
  if (prev) showScreen(prev, { push: false });
}

// ---------- DOM refs ----------

const rolePicker = document.getElementById("role-picker");
const formLeader = document.getElementById("form-leader");
const formMember = document.getElementById("form-member");
const memberJoinError = document.getElementById("member-join-error");

const appTripName = document.getElementById("app-trip-name");
const appTripCode = document.getElementById("app-trip-code");
const tripDatesEl = document.getElementById("trip-dates");
const tripCodeChip = document.getElementById("trip-code-chip");
const memberCountEl = document.getElementById("member-count");
const optionsBtn = document.getElementById("options-btn");
const appBackBtn = document.getElementById("app-back-btn");

const figureTotal = document.getElementById("figure-total");
const figureShare = document.getElementById("figure-share");
const figureBalance = document.getElementById("figure-balance");
const figureBalanceLabel = document.getElementById("figure-balance-label");
const figureCollected = document.getElementById("figure-collected");
const figureOutstanding = document.getElementById("figure-outstanding");
const settleProgressFill = document.getElementById("settle-progress-fill");

const feed = document.getElementById("feed");
const feedEmpty = document.getElementById("feed-empty");

const composer = document.getElementById("composer");
const composerDesc = document.getElementById("composer-desc");
const composerAmount = document.getElementById("composer-amount");

const membersOverlay = document.getElementById("members-overlay");
const membersList = document.getElementById("members-list");
const membersClose = document.getElementById("members-close");

const receiptBtn = document.getElementById("receipt-btn");
const receiptInput = document.getElementById("receipt-input");
const receiptOverlay = document.getElementById("receipt-overlay");
const receiptClose = document.getElementById("receipt-close");
const receiptPreview = document.getElementById("receipt-preview");
const receiptStatus = document.getElementById("receipt-status");
const receiptProgressBar = document.getElementById("receipt-progress-bar");
const receiptResult = document.getElementById("receipt-result");
const receiptDescInput = document.getElementById("receipt-desc");
const receiptAmountInput = document.getElementById("receipt-amount");
const receiptHint = document.getElementById("receipt-hint");
const receiptConfirm = document.getElementById("receipt-confirm");

// ---------- Role picker / auth flow ----------

rolePicker.querySelectorAll(".role-tile").forEach(tile => {
  tile.addEventListener("click", () => {
    showScreen(tile.dataset.role === "leader" ? "leader-form" : "member-form");
  });
});

document.querySelectorAll("[data-go-back]").forEach(btn => {
  btn.addEventListener("click", () => {
    memberJoinError.classList.add("hidden");
    goBack();
  });
});

formLeader.addEventListener("submit", (e) => {
  e.preventDefault();
  const leaderDateError = document.getElementById("leader-date-error");
  leaderDateError.classList.add("hidden");

  const leaderName = document.getElementById("leader-name").value.trim();
  const leaderPhone = document.getElementById("leader-phone").value.trim();
  const tripName = document.getElementById("leader-trip-name").value.trim();
  const startDate = document.getElementById("leader-start-date").value;
  const endDate = document.getElementById("leader-end-date").value;
  if (!leaderName || !leaderPhone || !tripName || !startDate || !endDate) return;

  if (endDate < startDate){
    leaderDateError.textContent = "End date can't be before the start date.";
    leaderDateError.classList.remove("hidden");
    return;
  }

  const { trip, memberId } = createTrip({ tripName, leaderName, leaderPhone, startDate, endDate });
  currentTrip = trip;
  currentMemberId = memberId;
  saveSession(trip.id, memberId);
  enterApp();
});

formMember.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("member-name").value.trim();
  const phone = document.getElementById("member-phone").value.trim();
  const tripId = document.getElementById("member-trip-id").value.trim();
  if (!name || !phone || !tripId) return;

  const result = joinTrip({ tripId, name, phone });
  if (result.error){
    memberJoinError.textContent = result.error;
    memberJoinError.classList.remove("hidden");
    return;
  }
  currentTrip = result.trip;
  currentMemberId = result.memberId;
  saveSession(result.trip.id, result.memberId);
  enterApp();
});

// ---------- Leaving the trip (back arrow on the main app screen) ----------

appBackBtn.addEventListener("click", () => {
  const ok = confirm("Leave this trip and go back to login? Your data stays saved under the trip code.");
  if (!ok) return;
  clearSession();
  navStack = [];
  currentTrip = null;
  currentMemberId = null;
  formLeader.reset();
  formMember.reset();
  showScreen("role-picker", { push: false });
});

// ---------- Entering the app ----------

function enterApp(){
  navStack = []; // fresh start — the login forms shouldn't sit behind the app
  showScreen("app", { push: false });
  renderAll();
}

function isLeader(){
  const me = currentTrip.members.find(m => m.id === currentMemberId);
  return !!me && me.role === "leader";
}

function renderAll(){
  currentTrip = loadTrip(currentTrip.id); // pull latest in case another tab/member changed it
  renderBalanceStrip();
  renderFeed();
}

function formatDate(isoStr){
  if (!isoStr) return "";
  const d = new Date(isoStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderBalanceStrip(){
  appTripName.textContent = currentTrip.name;
  appTripCode.textContent = currentTrip.id;
  memberCountEl.textContent = currentTrip.members.length;

  tripDatesEl.textContent = (currentTrip.startDate && currentTrip.endDate)
    ? formatDate(currentTrip.startDate) + " – " + formatDate(currentTrip.endDate)
    : "";

  const total = tripTotal(currentTrip);
  const share = perPersonShare(currentTrip);
  const balance = balanceForMember(currentTrip, currentMemberId);

  figureTotal.textContent = money(total);
  figureShare.textContent = money(share);

  // Effect 1: "Your balance" reflects YOUR OWN payment status once the
  // leader has marked you paid — it shows Settled regardless of the raw
  // owe/owed number, since as far as the group is concerned you're square.
  const me = currentTrip.members.find(m => m.id === currentMemberId);
  figureBalance.classList.remove("owe", "owed", "settled");
  if (me && me.paid){
    figureBalanceLabel.textContent = "Your balance";
    figureBalance.textContent = "Paid ✓";
    figureBalance.classList.add("settled");
  } else if (Math.abs(balance) < 0.01){
    figureBalanceLabel.textContent = "Your balance";
    figureBalance.textContent = "Settled up";
    figureBalance.classList.add("settled");
  } else if (balance < 0){
    figureBalanceLabel.textContent = "You owe the group";
    figureBalance.textContent = money(Math.abs(balance));
    figureBalance.classList.add("owe");
  } else {
    figureBalanceLabel.textContent = "The group owes you";
    figureBalance.textContent = money(balance);
    figureBalance.classList.add("owed");
  }

  // Effect 2: the trip total splits into Collected (share of everyone
  // the leader has marked paid) vs Outstanding (share of everyone still
  // pending), shown as a progress bar.
  const paidCount = currentTrip.members.filter(m => m.paid).length;
  const collected = share * paidCount;
  const outstanding = Math.max(total - collected, 0);
  const pct = total > 0 ? Math.min(100, Math.round((collected / total) * 100)) : 0;

  figureCollected.textContent = money(collected);
  figureOutstanding.textContent = money(outstanding);
  settleProgressFill.style.width = pct + "%";
}

function renderFeed(){
  const expenses = [...currentTrip.expenses].sort((a, b) => a.time - b.time);
  feed.querySelectorAll(".expense-row").forEach(el => el.remove());

  if (expenses.length === 0){
    feedEmpty.classList.remove("hidden");
    return;
  }
  feedEmpty.classList.add("hidden");

  const n = currentTrip.members.length;

  expenses.forEach(exp => {
    const payer = currentTrip.members.find(m => m.id === exp.payerId);
    const payerName = payer ? payer.name : "Someone";
    const isMe = exp.payerId === currentMemberId;

    const row = document.createElement("div");
    row.className = "expense-row";
    row.innerHTML = `
      <div class="expense-avatar">${initials(payerName)}</div>
      <div class="expense-bubble">
        <div class="expense-meta">
          <span class="expense-payer">${escapeHtml(payerName)}${isMe ? " (you)" : ""}</span>
          <span class="expense-time">${formatTime(exp.time)}</span>
        </div>
        <div class="expense-desc">${escapeHtml(exp.desc)}</div>
        <div class="expense-amount-row">
          <span class="expense-amount">${money(exp.amount)}</span>
          <span class="expense-split-note">split ${n} ways · ${money(exp.amount / n)} each</span>
        </div>
        ${exp.fromReceipt ? `<span class="expense-receipt-tag">from scanned receipt</span>` : ""}
      </div>
    `;
    feed.appendChild(row);
  });

  feed.scrollTop = feed.scrollHeight;
}

function formatTime(ts){
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + time;
}

function escapeHtml(str){
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Composer ----------

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const desc = composerDesc.value.trim();
  const amount = parseFloat(composerAmount.value);
  if (!desc || !amount || amount <= 0) return;

  addExpense(currentTrip, { payerId: currentMemberId, desc, amount });
  currentTrip = loadTrip(currentTrip.id);
  composerDesc.value = "";
  composerAmount.value = "";
  renderAll();
  if (!membersOverlay.classList.contains("hidden")) renderMembersList();
  showToast("Added — everyone's share just updated");
});

// ---------- Options / members panel ----------

optionsBtn.addEventListener("click", () => {
  renderMembersList();
  const note = document.getElementById("members-panel-note");
  if (note){
    note.textContent = isLeader()
      ? "Splitting is equal across everyone here. Tap a Paid/Pending badge to update someone's payment status."
      : "Splitting is equal across everyone here. Only the trip leader can update payment status.";
  }
  membersOverlay.classList.remove("hidden");
});
membersClose.addEventListener("click", () => membersOverlay.classList.add("hidden"));
membersOverlay.addEventListener("click", (e) => {
  if (e.target === membersOverlay) membersOverlay.classList.add("hidden");
});

function renderMembersList(){
  membersList.innerHTML = "";
  const iAmLeader = isLeader();
  currentTrip.members.forEach(m => {
    const bal = balanceForMember(currentTrip, m.id);
    let balClass = "settled", balText = "Settled up";
    if (Math.abs(bal) >= 0.01){
      balClass = bal < 0 ? "owe" : "owed";
      balText = (bal < 0 ? "owes " : "is owed ") + money(Math.abs(bal));
    }
    const paid = !!m.paid;
    const badgeClasses = "paid-badge " + (paid ? "paid" : "pending") + (iAmLeader ? " is-leader" : "");
    const badgeTitle = iAmLeader
      ? "Tap to mark as " + (paid ? "payment pending" : "payment settled")
      : "Only the trip leader can change this";

    const li = document.createElement("li");
    li.className = "member-row";
    li.innerHTML = `
      <div class="member-row-info">
        <div class="member-row-name-line">
          <strong>${escapeHtml(m.name)}${m.id === currentMemberId ? " (you)" : ""}</strong>
          <span class="member-row-role">${m.role === "leader" ? "Leader" : "Member"}</span>
          <button type="button" class="${badgeClasses}" data-paid-toggle title="${badgeTitle}">
            <span class="paid-dot"></span>${paid ? "Paid" : "Pending"}
          </button>
          <button type="button" class="copy-icon-btn" data-copy-name title="Copy name">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 9h10v10H9z" stroke="currentColor" stroke-width="2"/><path d="M5 15V5h10" stroke="currentColor" stroke-width="2"/></svg>
          </button>
        </div>
        <div class="member-row-phone-line">
          <span>${escapeHtml(m.phone)}</span>
          <button type="button" class="copy-icon-btn" data-copy-phone title="Copy phone number">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 9h10v10H9z" stroke="currentColor" stroke-width="2"/><path d="M5 15V5h10" stroke="currentColor" stroke-width="2"/></svg>
          </button>
        </div>
      </div>
      <div class="member-row-right">
        <span class="member-row-balance ${balClass}">${balText}</span>
      </div>
    `;
    li.querySelector("[data-copy-name]").addEventListener("click", () => copyToClipboard(m.name, "Name"));
    li.querySelector("[data-copy-phone]").addEventListener("click", () => copyToClipboard(m.phone, "Phone number"));
    li.querySelector("[data-paid-toggle]").addEventListener("click", () => {
      if (!iAmLeader){
        showToast("Only the trip leader can change payment status");
        return;
      }
      setMemberPaid(currentTrip, m.id, !paid);
      currentTrip = loadTrip(currentTrip.id);
      renderMembersList();
      renderBalanceStrip();
      showToast(escapeHtml(m.name) + (paid ? " marked as pending" : " marked as paid"));
    });
    membersList.appendChild(li);
  });
}

// ---------- Trip code copy ----------

tripCodeChip.addEventListener("click", () => copyToClipboard(currentTrip.id, "Trip code"));

// ---------- Receipt scanning ----------

receiptBtn.addEventListener("click", () => receiptInput.click());

receiptInput.addEventListener("change", async () => {
  const file = receiptInput.files[0];
  if (!file) return;

  receiptOverlay.classList.remove("hidden");
  receiptResult.classList.add("hidden");
  receiptStatus.textContent = "Reading the receipt…";
  receiptProgressBar.style.width = "0%";
  receiptPreview.src = URL.createObjectURL(file);

  try{
    const { data } = await Tesseract.recognize(file, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text"){
          receiptProgressBar.style.width = Math.round(m.progress * 100) + "%";
        } else {
          receiptStatus.textContent = capitalize(m.status) + "…";
        }
      }
    });
    handleReceiptText(data.text);
  } catch (err){
    console.error(err);
    receiptStatus.textContent = "Couldn't read that image clearly.";
    receiptHint.textContent = "No problem — just type the amount in below.";
    showReceiptFormFallback();
  }

  receiptInput.value = ""; // allow re-selecting the same file later
});

function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

function handleReceiptText(text){
  const amount = extractTotalAmount(text);
  const desc = guessDescription(text) || "Receipt expense";

  receiptStatus.textContent = "Here's what we found — check it before adding.";
  receiptProgressBar.style.width = "100%";
  receiptDescInput.value = desc;
  receiptAmountInput.value = amount != null ? amount : "";
  receiptHint.textContent = amount != null
    ? "Picked up the largest total-looking number on the receipt. Edit anything that's off."
    : "Couldn't confidently spot a total — enter it manually.";
  receiptResult.classList.remove("hidden");
}

function showReceiptFormFallback(){
  receiptDescInput.value = "";
  receiptAmountInput.value = "";
  receiptResult.classList.remove("hidden");
}

// Look for a line containing "total" (not "subtotal") and pull the largest
// number near it; fall back to the largest currency-like number in the text.
function extractTotalAmount(text){
  const lines = text.split("\n");
  const numberPattern = /(\d{1,3}(?:[,.]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;

  let bestFromTotalLine = null;
  for (const line of lines){
    const lower = line.toLowerCase();
    if (lower.includes("total") && !lower.includes("subtotal")){
      const nums = (line.match(numberPattern) || []).map(cleanNumber).filter(n => n > 0);
      if (nums.length){
        const candidate = Math.max(...nums);
        if (bestFromTotalLine == null || candidate > bestFromTotalLine) bestFromTotalLine = candidate;
      }
    }
  }
  if (bestFromTotalLine != null) return bestFromTotalLine;

  // Fallback: largest plausible number anywhere in the receipt
  const allNums = (text.match(numberPattern) || []).map(cleanNumber).filter(n => n > 0 && n < 1000000);
  if (allNums.length) return Math.max(...allNums);

  return null;
}

function cleanNumber(str){
  const normalized = str.replace(/,(?=\d{3}(\D|$))/g, "");
  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : n;
}

function guessDescription(text){
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  // First non-trivial line is usually the vendor/shop name on most receipts.
  const candidate = lines.find(l => l.length > 2 && !/^\d+$/.test(l));
  return candidate ? candidate.slice(0, 60) : null;
}

receiptConfirm.addEventListener("click", () => {
  const desc = receiptDescInput.value.trim();
  const amount = parseFloat(receiptAmountInput.value);
  if (!desc || !amount || amount <= 0){
    showToast("Add a description and amount first");
    return;
  }
  addExpense(currentTrip, { payerId: currentMemberId, desc, amount, fromReceipt: true });
  currentTrip = loadTrip(currentTrip.id);
  renderAll();
  if (!membersOverlay.classList.contains("hidden")) renderMembersList();
  receiptOverlay.classList.add("hidden");
  showToast("Added from receipt");
});

receiptClose.addEventListener("click", () => receiptOverlay.classList.add("hidden"));
receiptOverlay.addEventListener("click", (e) => {
  if (e.target === receiptOverlay) receiptOverlay.classList.add("hidden");
});

// ---------- Cross-tab live updates ----------
// If the leader and members happen to be testing in different tabs of the
// SAME browser, this keeps everyone's view in sync without a refresh.
window.addEventListener("storage", (e) => {
  if (currentTrip && e.key === STORAGE_PREFIX + currentTrip.id){
    renderAll();
    if (!membersOverlay.classList.contains("hidden")) renderMembersList();
  }
});

// ---------- Resume session on reload ----------

(function init(){
  const session = getSession();
  if (!session){
    showScreen("role-picker", { push: false });
    return;
  }
  const trip = loadTrip(session.tripId);
  if (!trip || !trip.members.some(m => m.id === session.memberId)){
    clearSession();
    showScreen("role-picker", { push: false });
    return;
  }
  currentTrip = trip;
  currentMemberId = session.memberId;
  enterApp();
})();
