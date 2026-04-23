require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");

const conn = require("./controllers/connecttoDB");
const curdate = require("./controllers/currentdate");
const Submission = require("./models/dailyRecord");
const MonthlyReport = require("./models/monthlyRecord");
const HrEmployee = require("./models/hrEmployee");
const User = require("./models/users");
const Tenant = require("./models/tenant");
const { verifyUser } = require("./controllers/verifyUser");
const { setUser, getUser } = require("./service/auth");

const PORT = process.env.PORT || 3000;
const milkPrice = process.env.MILKPRICE || 140;

conn(process.env.DB_URL);

function formatDateToPKR(date) {
  return new Date(date).toLocaleDateString("en-GB", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateToYMD(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function convertToMonthYear(monthYear) {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  if (/^\d{2}-\d{4}$/.test(monthYear)) {
    return monthYear;
  }

  const [monthName, year] = monthYear.split(" ");
  const monthIndex = monthNames.indexOf(monthName);

  if (monthIndex < 0 || !year) {
    return null;
  }

  const month = (monthIndex + 1).toString().padStart(2, "0");
  return `${month}-${year}`;
}

function formatMonth(monthYear) {
  const [month, year] = monthYear.split("-");
  const date = new Date(`${year}-${month}-01`);

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const monthName = monthNames[date.getMonth()];
  return `${monthName} ${year}`;
}

function parsePkrDateToObject(dateValue) {
  const [day, month, year] = String(dateValue || "").split("/").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function monthKeyFromDate(dateObj) {
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const year = dateObj.getFullYear();
  return `${month}-${year}`;
}

function parseMonthKey(monthKey) {
  const [monthRaw, yearRaw] = String(monthKey || "").split("-");
  return {
    month: Number(monthRaw),
    year: Number(yearRaw),
  };
}

function compareMonthKeys(a, b) {
  const aParsed = parseMonthKey(a);
  const bParsed = parseMonthKey(b);
  if (aParsed.year !== bParsed.year) {
    return aParsed.year - bParsed.year;
  }
  return aParsed.month - bParsed.month;
}

const TENANT_CODE_REGEX = /^(ALPHA|BETA|CHARLIE|DELTA)-\d{3}$/;
const monthlyReportsDirtyByTenant = new Map();

function normalizeTenantCode(rawCode) {
  const normalized = String(rawCode || "").trim().toUpperCase();
  return TENANT_CODE_REGEX.test(normalized) ? normalized : null;
}

function parseTenantIdentifier(prefix, codeNumber) {
  const normalizedPrefix = String(prefix || "").trim().toUpperCase();
  const numeric = Number(String(codeNumber || "").replace(/\D/g, ""));
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 999) {
    return null;
  }

  return normalizeTenantCode(`${normalizedPrefix}-${String(numeric).padStart(3, "0")}`);
}

function normalizeTenantIdentifierInput(tenantIdentifier, tenantPrefix, tenantCodeNumber) {
  const explicitCode = normalizeTenantCode(tenantIdentifier);
  if (explicitCode) {
    return explicitCode;
  }

  return parseTenantIdentifier(tenantPrefix, tenantCodeNumber);
}

function getTenantScope(source) {
  if (!source?.tenantId || !source?.tenantCode) {
    return null;
  }

  return {
    tenantId: source.tenantId,
    tenantCode: source.tenantCode,
  };
}

function addTenantScope(query = {}, tenantScope) {
  if (!tenantScope) {
    return {
      ...query,
      tenantCode: "__NO_TENANT_SCOPE__",
    };
  }

  return {
    ...query,
    tenantId: tenantScope.tenantId,
    tenantCode: tenantScope.tenantCode,
  };
}

function monthKeyFromPkrDateString(dateValue) {
  const dateObj = parsePkrDateToObject(dateValue);
  if (Number.isNaN(dateObj.getTime())) {
    return null;
  }
  return monthKeyFromDate(dateObj);
}

function markMonthlyReportsDirty(monthKey, tenantScope) {
  if (!monthKey || !tenantScope?.tenantId) {
    return;
  }

  const tenantKey = String(tenantScope.tenantId);
  const currentDirtyMonth = monthlyReportsDirtyByTenant.get(tenantKey) || null;

  if (!currentDirtyMonth || compareMonthKeys(monthKey, currentDirtyMonth) < 0) {
    monthlyReportsDirtyByTenant.set(tenantKey, monthKey);
  }
}

async function rebuildMonthlyReportsFromMonth(tenantScope, fromMonthKey = null) {
  const submissions = await Submission.find(addTenantScope({}, tenantScope), { date: 1, Balance: 1 }).lean();
  const netByMonth = new Map();

  submissions.forEach((entry) => {
    const dateObj = parsePkrDateToObject(entry.date);
    if (Number.isNaN(dateObj.getTime())) {
      return;
    }

    const monthKey = monthKeyFromDate(dateObj);
    const existing = netByMonth.get(monthKey) || 0;
    netByMonth.set(monthKey, existing + Number(entry.Balance || 0));
  });

  const sortedMonths = Array.from(netByMonth.keys()).sort(compareMonthKeys);

  if (sortedMonths.length === 0) {
    await MonthlyReport.deleteMany(addTenantScope({}, tenantScope));
    return;
  }

  const effectiveFromMonth = fromMonthKey || sortedMonths[0];
  const monthsToRebuild = sortedMonths.filter((monthKey) => compareMonthKeys(monthKey, effectiveFromMonth) >= 0);

  if (monthsToRebuild.length === 0) {
    const storedReports = await MonthlyReport.find(addTenantScope({}, tenantScope), { _id: 1, month: 1 }).lean();
    const staleIds = storedReports
      .filter((report) => compareMonthKeys(report.month, effectiveFromMonth) >= 0)
      .map((report) => report._id);

    if (staleIds.length > 0) {
      await MonthlyReport.deleteMany({ _id: { $in: staleIds } });
    }

    return;
  }

  let previousClosingBalance = 0;
  const previousMonth = sortedMonths
    .filter((monthKey) => compareMonthKeys(monthKey, monthsToRebuild[0]) < 0)
    .slice(-1)[0];

  if (previousMonth) {
    const previousReport = await MonthlyReport.findOne(addTenantScope({ month: previousMonth }, tenantScope), { closingBalance: 1 }).lean();
    previousClosingBalance = Number(previousReport?.closingBalance || 0);
  }

  for (const monthKey of monthsToRebuild) {
    const { month, year } = parseMonthKey(monthKey);
    const startDate = formatDateToPKR(new Date(year, month - 1, 1));
    const endDate = formatDateToPKR(new Date(year, month, 0));
    const openingBalance = roundMoney(previousClosingBalance);
    const netBalance = roundMoney(netByMonth.get(monthKey) || 0);
    const closingBalance = roundMoney(openingBalance + netBalance);

    await MonthlyReport.updateOne(
      addTenantScope({ month: monthKey }, tenantScope),
      {
        $set: {
          tenantId: tenantScope.tenantId,
          tenantCode: tenantScope.tenantCode,
          openingBalance,
          netBalance,
          closingBalance,
          startDate,
          endDate,
        },
      },
      { upsert: true },
    );

    previousClosingBalance = closingBalance;
  }

  const storedReports = await MonthlyReport.find(addTenantScope({}, tenantScope), { _id: 1, month: 1 }).lean();
  const staleIds = storedReports
    .filter((report) => compareMonthKeys(report.month, monthsToRebuild[0]) >= 0 && !netByMonth.has(report.month))
    .map((report) => report._id);

  if (staleIds.length > 0) {
    await MonthlyReport.deleteMany({ _id: { $in: staleIds } });
  }
}

async function ensureMonthlyReportsUpToDate(tenantScope) {
  const scope = getTenantScope(tenantScope);
  if (!scope) {
    return;
  }

  const tenantKey = String(scope.tenantId);
  const dirtyMonth = monthlyReportsDirtyByTenant.get(tenantKey);
  if (!dirtyMonth) {
    return;
  }

  await rebuildMonthlyReportsFromMonth(scope, dirtyMonth);
  monthlyReportsDirtyByTenant.delete(tenantKey);
}

function isCurrentMonthDate(ddmmyyyy) {
  const [day, month, year] = ddmmyyyy.split("/").map(Number);
  const selected = new Date(year, month - 1, day);
  const todayParts = curdate().split("/").map(Number);
  const current = new Date(todayParts[2], todayParts[1] - 1, todayParts[0]);

  return selected.getMonth() === current.getMonth() && selected.getFullYear() === current.getFullYear();
}

function getCurrentMonthInputRange() {
  const todayParts = curdate().split("/").map(Number);
  const year = todayParts[2];
  const month = todayParts[1];
  const monthStr = String(month).padStart(2, "0");

  const minDate = `${year}-${monthStr}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const maxDate = `${year}-${monthStr}-${String(lastDay).padStart(2, "0")}`;

  return { minDate, maxDate };
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function roundUpMoney(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  const rounded = Math.ceil(numeric * 100) / 100;
  return Math.abs(rounded) < 0.000001 ? 0 : rounded;
}

function parseDateToPKR(dateValue) {
  if (!dateValue) {
    return curdate();
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateValue)) {
    return dateValue;
  }

  return formatDateToPKR(dateValue);
}

function pkrDateToYmd(dateValue) {
  const [day, month, year] = dateValue.split("/").map(Number);
  return formatDateToYMD(new Date(year, month - 1, day));
}

function daysInclusive(startDate, endDate) {
  const start = new Date(pkrDateToYmd(startDate));
  const end = new Date(pkrDateToYmd(endDate));
  const diff = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, diff);
}

function calculateProratedBasePay(monthlyPay, startDate, endDate) {
  let cursor = new Date(pkrDateToYmd(startDate));
  const last = new Date(pkrDateToYmd(endDate));

  if (cursor > last) {
    return roundUpMoney(monthlyPay / 30);
  }

  let total = 0;

  while (cursor <= last) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    total += Number(monthlyPay || 0) / daysInMonth;
    cursor.setDate(cursor.getDate() + 1);
  }

  return roundUpMoney(total);
}

function getEmployeeSettlementSnapshot(employee, settlementDate = curdate()) {
  const lastSettlementDate = employee.lastSettlementDate || employee.joiningDate;
  const startYmd = pkrDateToYmd(lastSettlementDate);
  const endYmd = pkrDateToYmd(settlementDate);
  const isFirstSettlement = (employee.settlements || []).length === 0;
  const sameDaySettlement = startYmd === endYmd;
  const zeroBaseSameDay = sameDaySettlement && !isFirstSettlement;
  const eligibleTransactions = (employee.transactions || []).filter((transaction) => {
    if (transaction.settledAt) {
      return false;
    }

    const transactionYmd = pkrDateToYmd(transaction.transactionDate);
    return transactionYmd >= startYmd && transactionYmd <= endYmd;
  });

  const advances = eligibleTransactions.filter((transaction) => transaction.type === "advance");
  const paybacks = eligibleTransactions.filter((transaction) => transaction.type === "payback");
  const daysWorked = zeroBaseSameDay ? 0 : daysInclusive(lastSettlementDate, settlementDate);
  const basePay = zeroBaseSameDay ? 0 : calculateProratedBasePay(employee.monthlyPay, lastSettlementDate, settlementDate);
  const dailyRate = daysWorked > 0 ? roundUpMoney(basePay / daysWorked) : 0;
  const advancesTotal = roundMoney(advances.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0));
  const paybacksTotal = roundMoney(paybacks.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0));
  const netPay = roundUpMoney(basePay + paybacksTotal - advancesTotal);

  return {
    settlementDate,
    lastSettlementDate,
    daysWorked,
    dailyRate,
    basePay,
    advancesTotal,
    paybacksTotal,
    netPay,
    eligibleTransactions,
  };
}

function validateSettlementDateWindow(employee, settlementDate) {
  const lastSettlementDate = employee.lastSettlementDate || employee.joiningDate;
  const settlementYmd = pkrDateToYmd(settlementDate);
  const lastSettlementYmd = pkrDateToYmd(lastSettlementDate);
  const todayYmd = pkrDateToYmd(curdate());

  if (settlementYmd < lastSettlementYmd) {
    return {
      valid: false,
      message: `Settlement date cannot be before last settlement date (${lastSettlementDate})`,
    };
  }

  if (settlementYmd > todayYmd) {
    return {
      valid: false,
      message: "Settlement date cannot be in the future",
    };
  }

  return { valid: true };
}

function validateLeftDateWindow(employee, leftDate) {
  const leftYmd = pkrDateToYmd(leftDate);
  const joiningYmd = pkrDateToYmd(employee.joiningDate);
  const lastSettlementYmd = pkrDateToYmd(employee.lastSettlementDate || employee.joiningDate);
  const todayYmd = pkrDateToYmd(curdate());

  if (leftYmd < joiningYmd) {
    return {
      valid: false,
      message: `Left date cannot be before joining date (${employee.joiningDate})`,
    };
  }

  if (leftYmd < lastSettlementYmd) {
    return {
      valid: false,
      message: `Left date cannot be before last settlement date (${employee.lastSettlementDate || employee.joiningDate})`,
    };
  }

  if (leftYmd > todayYmd) {
    return {
      valid: false,
      message: "Left date cannot be in the future",
    };
  }

  return { valid: true };
}

function formatEmployeeSummary(employee, settlementDate = curdate()) {
  const snapshot = getEmployeeSettlementSnapshot(employee, settlementDate);
  return {
    id: employee._id,
    name: employee.name,
    monthlyPay: employee.monthlyPay,
    joiningDate: employee.joiningDate,
    lastSettlementDate: employee.lastSettlementDate,
    currentDue: snapshot.netPay,
    netBalance: snapshot.netPay,
    advancesTotal: snapshot.advancesTotal,
    paybacksTotal: snapshot.paybacksTotal,
    pendingTransactions: snapshot.eligibleTransactions.length,
    settlementCount: (employee.settlements || []).length,
    employmentStatus: employee.employmentStatus || "active",
    leftDate: employee.leftDate || null,
    payAtLeaving: employee.payAtLeaving || null,
    netBalanceAtLeaving: Number(employee.netBalanceAtLeaving || 0),
  };
}

function formatLeftEmployeeSummary(employee) {
  const storedPayAtLeaving = Number(employee.payAtLeaving || 0);
  const safePayAtLeaving = storedPayAtLeaving > 0 ? storedPayAtLeaving : Number(employee.monthlyPay || 0);

  return {
    id: employee._id,
    name: employee.name,
    joiningDate: employee.joiningDate,
    leftDate: employee.leftDate || null,
    payAtLeaving: safePayAtLeaving,
    netBalanceAtLeaving: Number(employee.netBalanceAtLeaving || 0),
  };
}

function sendSuccess(res, data, message = "OK", status = 200) {
  return res.status(status).json({ success: true, message, data });
}

function sendError(res, message, status = 500, details = null) {
  return res.status(status).json({ success: false, message, details });
}

function deriveUser(req, res, next) {
  req.user = null;
  if (req.cookies?.tId) {
    try {
      req.user = getUser(req.cookies.tId);
    } catch (err) {
      req.user = null;
    }
  }
  next();
}

function getRequestTenantScope(req) {
  return getTenantScope(req?.user);
}

function userPayload(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    tenantId: user.tenantId,
    tenantCode: user.tenantCode,
    tenantName: user.tenantName || null,
    tenantIsActive: typeof user.tenantIsActive === "boolean" ? user.tenantIsActive : null,
    tenantSubscriptionExpiresAt: user.tenantSubscriptionExpiresAt || null,
  };
}

function getTenantStatus(tenant) {
  if (!tenant) {
    return { isActiveNow: false };
  }

  const now = new Date();
  const expiresAt = tenant.inactiveUntil ? new Date(tenant.inactiveUntil) : null;
  const isExpired = Boolean(expiresAt && expiresAt.getTime() <= now.getTime());
  const isActiveNow = Boolean(tenant.isActive && !isExpired);

  return {
    isActiveNow,
    isExpired,
    inactiveUntil: expiresAt,
  };
}

async function ensureTenantIsActive(req, res) {
  if (req.user.role === "superadmin" && (!req.user?.tenantId || !req.user?.tenantCode)) {
    return { ok: true };
  }

  if (!req.user?.tenantId || !req.user?.tenantCode) {
    return { ok: false, response: sendError(res, "Tenant context missing. Please sign in again.", 401) };
  }

  const tenant = await Tenant.findOne({
    _id: req.user.tenantId,
    code: req.user.tenantCode,
  });

  const status = getTenantStatus(tenant);

  if (tenant && status.isExpired && tenant.isActive) {
    tenant.isActive = false;
    await tenant.save();
  }

  if (!tenant || !status.isActiveNow) {
    return { ok: false, response: sendError(res, "Your tenant is inactive. Contact superadmin.", 403) };
  }

  return { ok: true };
}

async function requireAuth(req, res, next) {
  if (!req.user) {
    return sendError(res, "Authentication required", 401);
  }

  return next();
}

async function requireAdmin(req, res, next) {
  if (!req.user) {
    return sendError(res, "Authentication required", 401);
  }

  if (!["admin", "superadmin"].includes(req.user.role)) {
    return sendError(res, "Admin or superadmin access required", 403);
  }

  return next();
}

async function requireSuperadmin(req, res, next) {
  if (!req.user) {
    return sendError(res, "Authentication required", 401);
  }

  if (req.user.role !== "superadmin") {
    return sendError(res, "Superadmin access required", 403);
  }

  return next();
}

function normalizeAmounts(list) {
  const arr = Object.values(list || {});
  arr.forEach((val) => {
    val.amount = +val.amount;
  });
  return arr;
}

function sanitizeLineItemDescription(value) {
  return String(value || "").trim();
}

function isReadonlyDailyLineItem(item) {
  return Boolean(item && (item.readonly || item.source === "hr"));
}

function splitDailyLineItems(items) {
  const readonlyItems = [];
  const editableItems = [];

  (items || []).forEach((item) => {
    if (isReadonlyDailyLineItem(item)) {
      readonlyItems.push(item);
    } else {
      editableItems.push(item);
    }
  });

  return { readonlyItems, editableItems };
}

function normalizeEditableLineItems(items) {
  return (items || [])
    .map((item) => ({
      description: sanitizeLineItemDescription(item.description),
      amount: Number(item.amount || 0),
      readonly: false,
      source: "manual",
      sourceRefType: null,
      sourceRefId: null,
    }))
    .filter((item) => item.description && item.amount > 0)
    .map((item) => ({ ...item, amount: roundMoney(item.amount) }));
}

function normalizeReadonlyLineItems(items) {
  return (items || [])
    .filter((item) => isReadonlyDailyLineItem(item))
    .map((item) => ({
      description: sanitizeLineItemDescription(item.description),
      amount: roundMoney(Number(item.amount || 0)),
      readonly: true,
      source: item.source || "hr",
      sourceRefType: item.sourceRefType || null,
      sourceRefId: item.sourceRefId ? String(item.sourceRefId) : null,
    }))
    .filter((item) => item.description && item.amount > 0);
}

function calculateRecordTotals(morningMilk, eveningMilk, milkRate, expensesArray, revenuesArray) {
  const milkRevenue = (Number(morningMilk || 0) + Number(eveningMilk || 0)) * Number(milkRate || 0);
  const totalExpenses = (expensesArray || []).reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const totalRevenue = (revenuesArray || []).reduce((sum, revenue) => sum + Number(revenue.amount || 0), 0) + milkRevenue;
  const balance = totalRevenue - totalExpenses;

  return {
    milkRevenue: roundMoney(milkRevenue),
    totalExpenses: roundMoney(totalExpenses),
    totalRevenue: roundMoney(totalRevenue),
    balance: roundMoney(balance),
  };
}

function buildHrDailyLineItem(employee, transaction) {
  const refId = String(transaction._id);
  const prefix = transaction.type === "advance" ? "HR Advance" : "HR Payback";
  const note = sanitizeLineItemDescription(transaction.note);
  const baseDescription = `${prefix} - ${sanitizeLineItemDescription(employee.name) || "Employee"}`;
  const description = note ? `${baseDescription} (${note})` : baseDescription;

  return {
    description,
    amount: roundMoney(Number(transaction.amount || 0)),
    readonly: true,
    source: "hr",
    sourceRefType: "hr_transaction",
    sourceRefId: refId,
  };
}

async function removeHrTransactionFromDailyRecords(transactionId, tenantScope, dateHint = null) {
  const refId = String(transactionId);
  const baseQuery = {
    $or: [
      { "expenses.sourceRefId": refId },
      { "revenues.sourceRefId": refId },
    ],
  };
  const query = dateHint ? { ...baseQuery, date: dateHint } : baseQuery;
  const scopedQuery = addTenantScope(query, tenantScope);
  const records = await Submission.find(scopedQuery);

  for (const record of records) {
    const nextExpenses = (record.expenses || []).filter((item) => String(item.sourceRefId || "") !== refId);
    const nextRevenues = (record.revenues || []).filter((item) => String(item.sourceRefId || "") !== refId);
    const removed = nextExpenses.length !== (record.expenses || []).length
      || nextRevenues.length !== (record.revenues || []).length;

    if (!removed) {
      continue;
    }

    const totals = calculateRecordTotals(
      record.morningMilkQuantity,
      record.eveningMilkQuantity,
      record.milkPrice,
      nextExpenses,
      nextRevenues,
    );

    record.expenses = nextExpenses;
    record.revenues = nextRevenues;
    record.totalRevenue = totals.totalRevenue;
    record.totalExpenditure = totals.totalExpenses;
    record.Balance = totals.balance;
    await record.save();
    markMonthlyReportsDirty(monthKeyFromPkrDateString(record.date), tenantScope);
  }
}

async function upsertHrTransactionIntoDailyRecord(employee, transaction) {
  const tenantScope = getTenantScope(employee);
  if (!tenantScope) {
    throw new Error("Employee tenant context is missing");
  }

  const transactionDate = parseDateToPKR(transaction.transactionDate || curdate());
  let record = await Submission.findOne(addTenantScope({ date: transactionDate }, tenantScope));

  if (!record) {
    const milkRate = Number(milkPrice || 0);
    record = new Submission({
      tenantId: tenantScope.tenantId,
      tenantCode: tenantScope.tenantCode,
      date: transactionDate,
      morningMilkQuantity: 0,
      eveningMilkQuantity: 0,
      milkPrice: milkRate,
      expenses: [],
      revenues: [],
      totalRevenue: 0,
      totalExpenditure: 0,
      Balance: 0,
    });
  }

  const refId = String(transaction._id);
  record.expenses = (record.expenses || []).filter((item) => String(item.sourceRefId || "") !== refId);
  record.revenues = (record.revenues || []).filter((item) => String(item.sourceRefId || "") !== refId);

  const targetKey = transaction.type === "advance" ? "expenses" : "revenues";
  record[targetKey] = [...(record[targetKey] || []), buildHrDailyLineItem(employee, transaction)];

  const totals = calculateRecordTotals(
    record.morningMilkQuantity,
    record.eveningMilkQuantity,
    record.milkPrice,
    record.expenses,
    record.revenues,
  );

  record.totalRevenue = totals.totalRevenue;
  record.totalExpenditure = totals.totalExpenses;
  record.Balance = totals.balance;
  await record.save();
  markMonthlyReportsDirty(monthKeyFromPkrDateString(transactionDate), tenantScope);
}

async function updateRecordHandler(req, res, decodedDate) {
  const { morningMilk, eveningMilk, expenses, revenues } = req.body;
  const incomingExpenses = normalizeAmounts(expenses);
  const incomingRevenues = normalizeAmounts(revenues);
  const tenantScope = getRequestTenantScope(req);

  try {
    const oldEntry = await Submission.findOne(addTenantScope({ date: decodedDate }, tenantScope));
    if (!oldEntry) {
      return sendError(res, "Record not found", 404);
    }

    const currentMilkPrice = Number(oldEntry?.milkPrice ?? milkPrice);
    const { readonlyItems: readonlyExpenses } = splitDailyLineItems(oldEntry.expenses || []);
    const { readonlyItems: readonlyRevenues } = splitDailyLineItems(oldEntry.revenues || []);
    const editableExpenses = normalizeEditableLineItems(incomingExpenses);
    const editableRevenues = normalizeEditableLineItems(incomingRevenues);
    const normalizedReadonlyExpenses = normalizeReadonlyLineItems(readonlyExpenses);
    const normalizedReadonlyRevenues = normalizeReadonlyLineItems(readonlyRevenues);
    const expensesArray = [...editableExpenses, ...normalizedReadonlyExpenses];
    const revenuesArray = [...editableRevenues, ...normalizedReadonlyRevenues];
    const totals = calculateRecordTotals(morningMilk, eveningMilk, currentMilkPrice, expensesArray, revenuesArray);

    const updatedEntry = await Submission.findOneAndUpdate(
      addTenantScope({ date: decodedDate }, tenantScope),
      {
        morningMilkQuantity: morningMilk,
        eveningMilkQuantity: eveningMilk,
        milkPrice: currentMilkPrice,
        expenses: expensesArray,
        revenues: revenuesArray,
        totalRevenue: totals.totalRevenue,
        totalExpenditure: totals.totalExpenses,
        Balance: totals.balance,
      },
      { new: true }
    );

    markMonthlyReportsDirty(monthKeyFromPkrDateString(decodedDate), tenantScope);
    await ensureMonthlyReportsUpToDate(tenantScope);

    return sendSuccess(res, { date: decodedDate, updatedEntry, tenant: { code: tenantScope.tenantCode } }, "Record updated");
  } catch (err) {
    console.log(err);
    return sendError(res, "Something went wrong while updating record", 500);
  }
}

const app = express();

app.use(cookieParser(process.env.SECRET_KEY));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(deriveUser);

function normalizeOrigin(origin) {
  if (!origin) {
    return "";
  }
  return origin.trim().replace(/\/+$/, "");
}

app.use((req, res, next) => {
  const configuredOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);

  const requestOrigin = normalizeOrigin(req.headers.origin || "");
  const isAllowed = configuredOrigins.includes(requestOrigin);

  if (isAllowed) {
    // Echo the request origin for exact browser CORS matching.
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    if (!isAllowed) {
      return res.sendStatus(403);
    }
    return res.sendStatus(204);
  }

  return next();
});

app.get("/api/health", (req, res) => {
  return sendSuccess(res, { up: true, date: curdate() }, "Server is running");
});

app.get(["/", "/home"], requireAuth, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const entry = await Submission.findOne(addTenantScope({ date: curdate() }, tenantScope));
    return sendSuccess(res, {
      user: userPayload(req.user),
      tenant: {
        id: tenantScope.tenantId,
        code: tenantScope.tenantCode,
      },
      today: curdate(),
      todayEntryExists: Boolean(entry),
    }, "Dashboard data fetched");
  } catch (err) {
    console.error("Error fetching dashboard:", err);
    return sendError(res, "Error fetching dashboard", 500);
  }
});

app.get("/login", (req, res) => {
  return sendSuccess(res, {
    deprecated: true,
    loginEndpoint: "/api/auth/login",
  }, "Use POST /api/auth/login");
});

app.post(["/api/auth/login", "/login"], async (req, res) => {
  const { email, password, tenantIdentifier, tenantPrefix, tenantCodeNumber } = req.body;
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const superadminUser = await User.findOne({
    email: normalizedEmail,
    password,
    role: "superadmin",
  });

  if (superadminUser) {
    const token = setUser({
      ...superadminUser.toObject(),
      tenantId: null,
      tenantCode: null,
      tenantName: null,
    });
    const oneMonth = 30 * 24 * 60 * 60 * 1000;
    const isProd = process.env.NODE_ENV === "production";

    res.cookie("tId", token, {
      expires: new Date(Date.now() + oneMonth),
      httpOnly: true,
      sameSite: isProd ? "none" : "lax",
      secure: isProd,
    });

    return sendSuccess(res, {
      user: {
        ...userPayload({
          ...superadminUser.toObject(),
          tenantId: null,
          tenantCode: null,
          tenantName: null,
        }),
      },
    }, "Login successful");
  }

  const normalizedTenantCode = normalizeTenantIdentifierInput(tenantIdentifier, tenantPrefix, tenantCodeNumber);
  if (!normalizedTenantCode) {
    return sendError(res, "Tenant identifier is required for admin login", 400, {
      requiredFormat: "Select ALPHA/BETA/CHARLIE/DELTA and code 001..999",
    });
  }

  const tenant = await Tenant.findOne({ code: normalizedTenantCode });
  const tenantStatus = getTenantStatus(tenant);

  if (!tenant) {
    return sendError(res, "Tenant is invalid or inactive", 401);
  }

  const user = await verifyUser(normalizedEmail, password, tenant);

  if (!user) {
    return sendError(res, "Invalid credentials", 401);
  }

  const token = setUser({
    ...user.toObject(),
    tenantId: tenant._id,
    tenantCode: tenant.code,
    tenantName: tenant.name,
    tenantIsActive: Boolean(tenantStatus.isActiveNow),
    tenantSubscriptionExpiresAt: tenant.inactiveUntil || null,
  });
  const oneMonth = 30 * 24 * 60 * 60 * 1000;
  const isProd = process.env.NODE_ENV === "production";

  res.cookie("tId", token, {
    expires: new Date(Date.now() + oneMonth),
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
  });

  return sendSuccess(res, {
    user: {
      ...userPayload({
        ...user.toObject(),
        tenantId: tenant._id,
        tenantCode: tenant.code,
        tenantName: tenant.name,
        tenantIsActive: Boolean(tenantStatus.isActiveNow),
        tenantSubscriptionExpiresAt: tenant.inactiveUntil || null,
      }),
    },
  }, "Login successful");
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  return sendSuccess(res, {
    user: userPayload(req.user),
  }, "Authenticated user fetched");
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    if (!tenantScope) {
      return sendError(res, "Tenant context missing. Please sign in again.", 401);
    }

    const users = await User.find({
      ...addTenantScope({}, tenantScope),
      role: { $ne: "superadmin" },
    }).sort({ createdAt: -1 });
    return sendSuccess(res, {
      users: users.map((user) => ({
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
    }, "Tenant users fetched");
  } catch (err) {
    console.error("Error fetching tenant users:", err);
    return sendError(res, "Unable to fetch tenant users", 500);
  }
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "user").trim();

  if (!name || !email || !password) {
    return sendError(res, "Name, email, and password are required", 400);
  }

  if (!["user", "admin"].includes(role)) {
    return sendError(res, "Role must be user or admin", 400);
  }

  const tenantScope = getRequestTenantScope(req);
  if (!tenantScope) {
    return sendError(res, "Tenant context missing. Please sign in again.", 401);
  }

  try {
    const existingUser = await User.findOne({
      email,
      tenantCode: tenantScope.tenantCode,
    }).lean();

    if (existingUser) {
      return sendError(res, "User already exists in this tenant", 409);
    }

    const createdUser = await User.create({
      name,
      email,
      password,
      role,
      tenantId: tenantScope.tenantId,
      tenantCode: tenantScope.tenantCode,
    });

    return sendSuccess(res, {
      user: {
        id: createdUser._id,
        name: createdUser.name,
        email: createdUser.email,
        role: createdUser.role,
        createdAt: createdUser.createdAt,
        updatedAt: createdUser.updatedAt,
      },
    }, "Tenant user created", 201);
  } catch (err) {
    console.error("Error creating tenant user:", err);
    return sendError(res, "Unable to create tenant user", 500);
  }
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    if (!tenantScope) {
      return sendError(res, "Tenant context missing. Please sign in again.", 401);
    }

    const user = await User.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!user) {
      return sendError(res, "User not found", 404);
    }

    if (user.role === "superadmin") {
      return sendError(res, "Superadmin users cannot be deleted from tenant settings", 400);
    }

    if (String(user._id) === String(req.user._id)) {
      return sendError(res, "You cannot delete your own account", 400);
    }

    if (user.role === "admin") {
      const remainingAdmins = await User.countDocuments(addTenantScope({ role: "admin" }, tenantScope));
      if (remainingAdmins <= 1) {
        return sendError(res, "At least one admin must remain in the tenant", 400);
      }
    }

    await User.deleteOne({ _id: user._id });
    return sendSuccess(res, null, "Tenant user deleted");
  } catch (err) {
    console.error("Error deleting tenant user:", err);
    return sendError(res, "Unable to delete tenant user", 500);
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("tId");
  return sendSuccess(res, null, "Logged out");
});

app.get("/logout", (req, res) => {
  res.clearCookie("tId");
  return sendSuccess(res, { deprecated: true }, "Logged out");
});

app.get("/api/hr/overview", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employees = await HrEmployee.find(addTenantScope({}, tenantScope)).sort({ createdAt: -1 });
    const activeEmployees = employees.filter((employee) => (employee.employmentStatus || "active") !== "left");
    const leftEmployees = employees.filter((employee) => (employee.employmentStatus || "active") === "left");
    const employeeSummaries = activeEmployees.map((employee) => formatEmployeeSummary(employee));
    const leftEmployeeSummaries = leftEmployees.map((employee) => formatLeftEmployeeSummary(employee));
    const totals = employeeSummaries.reduce(
      (acc, employee) => ({
        totalEmployees: acc.totalEmployees + 1,
        totalMonthlyPay: acc.totalMonthlyPay + Number(employee.monthlyPay || 0),
        totalCurrentDue: acc.totalCurrentDue + Number(employee.currentDue || 0),
        totalAdvances: acc.totalAdvances + Number(employee.advancesTotal || 0),
        totalPaybacks: acc.totalPaybacks + Number(employee.paybacksTotal || 0),
      }),
      { totalEmployees: 0, totalMonthlyPay: 0, totalCurrentDue: 0, totalAdvances: 0, totalPaybacks: 0 },
    );

    return sendSuccess(res, {
      employees: employeeSummaries,
      leftEmployees: leftEmployeeSummaries,
      totals,
      date: curdate(),
    }, "HR overview fetched");
  } catch (err) {
    console.error("Error fetching HR overview:", err);
    return sendError(res, "Error fetching HR overview", 500);
  }
});

app.post("/api/hr/employees", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const name = String(req.body.name || "").trim();
    const monthlyPay = Number(req.body.monthlyPay || 0);
    const joiningDate = parseDateToPKR(req.body.joiningDate || curdate());

    if (!name) {
      return sendError(res, "Employee name is required", 400);
    }

    if (!monthlyPay || monthlyPay <= 0) {
      return sendError(res, "Monthly pay must be greater than zero", 400);
    }

    const employee = new HrEmployee({
      tenantId: tenantScope.tenantId,
      tenantCode: tenantScope.tenantCode,
      name,
      monthlyPay: roundMoney(monthlyPay),
      joiningDate,
      lastSettlementDate: joiningDate,
      transactions: [],
      settlements: [],
      salaryAdjustments: [],
    });

    await employee.save();

    return sendSuccess(res, { employee: formatEmployeeSummary(employee) }, "Employee added", 201);
  } catch (err) {
    console.error("Error creating HR employee:", err);
    return sendError(res, "Error creating employee", 500);
  }
});

app.get("/api/hr/employees/:id", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employee = await HrEmployee.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!employee) {
      return sendError(res, "Employee not found", 404);
    }

    const snapshot = getEmployeeSettlementSnapshot(employee);

    return sendSuccess(res, {
      employee: {
        id: employee._id,
        name: employee.name,
        monthlyPay: employee.monthlyPay,
        joiningDate: employee.joiningDate,
        lastSettlementDate: employee.lastSettlementDate,
        currentDue: snapshot.netPay,
        netBalance: snapshot.netPay,
        employmentStatus: employee.employmentStatus || "active",
        leftDate: employee.leftDate || null,
        payAtLeaving: employee.payAtLeaving || null,
        netBalanceAtLeaving: Number(employee.netBalanceAtLeaving || 0),
        transactions: employee.transactions || [],
        settlements: employee.settlements || [],
        salaryAdjustments: employee.salaryAdjustments || [],
      },
      snapshot,
    }, "Employee fetched");
  } catch (err) {
    console.error("Error fetching HR employee:", err);
    return sendError(res, "Error fetching employee", 500);
  }
});

app.post("/api/hr/employees/:id/transactions", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employee = await HrEmployee.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!employee) {
      return sendError(res, "Employee not found", 404);
    }

    if ((employee.employmentStatus || "active") === "left") {
      return sendError(res, "This employee has left and cannot receive transactions", 400);
    }

    const type = String(req.body.type || "").trim();
    const amount = Number(req.body.amount || 0);
    const note = String(req.body.note || "").trim();
    const transactionDate = parseDateToPKR(req.body.transactionDate || curdate());

    if (!["advance", "payback"].includes(type)) {
      return sendError(res, "Transaction type must be advance or payback", 400);
    }

    if (!amount || amount <= 0) {
      return sendError(res, "Transaction amount must be greater than zero", 400);
    }

    employee.transactions.push({
      type,
      amount: roundMoney(amount),
      note,
      transactionDate,
      settledAt: null,
    });

    await employee.save();
    const createdTransaction = employee.transactions[employee.transactions.length - 1];
    await upsertHrTransactionIntoDailyRecord(employee, createdTransaction);
    await ensureMonthlyReportsUpToDate(tenantScope);

    return sendSuccess(res, {
      employee: formatEmployeeSummary(employee),
      transaction: createdTransaction,
    }, "Transaction added", 201);
  } catch (err) {
    console.error("Error adding HR transaction:", err);
    return sendError(res, "Error adding transaction", 500);
  }
});

app.put("/api/hr/employees/:id/transactions/:transactionId", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employee = await HrEmployee.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!employee) {
      return sendError(res, "Employee not found", 404);
    }

    if ((employee.employmentStatus || "active") === "left") {
      return sendError(res, "This employee has left and transactions cannot be edited", 400);
    }

    const transaction = (employee.transactions || []).id(req.params.transactionId);
    if (!transaction) {
      return sendError(res, "Transaction not found", 404);
    }

    if (transaction.settledAt) {
      return sendError(res, "Settled transaction cannot be edited", 400);
    }

    const previousTransactionDate = transaction.transactionDate;
    const type = String(req.body.type || transaction.type).trim();
    const amount = Number(req.body.amount || 0);
    const note = String(req.body.note || "").trim();
    const transactionDate = parseDateToPKR(req.body.transactionDate || curdate());

    if (![
      "advance",
      "payback",
    ].includes(type)) {
      return sendError(res, "Transaction type must be advance or payback", 400);
    }

    if (!amount || amount <= 0) {
      return sendError(res, "Transaction amount must be greater than zero", 400);
    }

    transaction.type = type;
    transaction.amount = roundMoney(amount);
    transaction.note = note;
    transaction.transactionDate = transactionDate;

    await employee.save();
    await removeHrTransactionFromDailyRecords(transaction._id, tenantScope, previousTransactionDate);
    await upsertHrTransactionIntoDailyRecord(employee, transaction);
    await ensureMonthlyReportsUpToDate(tenantScope);

    return sendSuccess(res, {
      employee: formatEmployeeSummary(employee),
      transaction,
    }, "Transaction updated");
  } catch (err) {
    console.error("Error updating HR transaction:", err);
    return sendError(res, "Error updating transaction", 500);
  }
});

app.delete("/api/hr/employees/:id/transactions/:transactionId", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employee = await HrEmployee.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!employee) {
      return sendError(res, "Employee not found", 404);
    }

    if ((employee.employmentStatus || "active") === "left") {
      return sendError(res, "This employee has left and transactions cannot be deleted", 400);
    }

    const transaction = (employee.transactions || []).id(req.params.transactionId);
    if (!transaction) {
      return sendError(res, "Transaction not found", 404);
    }

    if (transaction.settledAt) {
      return sendError(res, "Settled transaction cannot be deleted", 400);
    }

    const transactionDate = transaction.transactionDate;
    transaction.deleteOne();

    await employee.save();
    await removeHrTransactionFromDailyRecords(transaction._id, tenantScope, transactionDate);
    await ensureMonthlyReportsUpToDate(tenantScope);

    return sendSuccess(res, {
      employee: formatEmployeeSummary(employee),
    }, "Transaction deleted");
  } catch (err) {
    console.error("Error deleting HR transaction:", err);
    return sendError(res, "Error deleting transaction", 500);
  }
});

app.post("/api/hr/employees/:id/increase-pay", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employee = await HrEmployee.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!employee) {
      return sendError(res, "Employee not found", 404);
    }

    if ((employee.employmentStatus || "active") === "left") {
      return sendError(res, "This employee has left and cannot receive a pay increase", 400);
    }

    const increaseAmount = Number(req.body.increaseAmount || 0);
    const note = String(req.body.note || "").trim();
    const effectiveDate = parseDateToPKR(req.body.effectiveDate || curdate());

    if (!increaseAmount || increaseAmount <= 0) {
      return sendError(res, "Increase amount must be greater than zero", 400);
    }

    const previousPay = Number(employee.monthlyPay || 0);
    const newMonthlyPay = roundMoney(previousPay + increaseAmount);

    employee.monthlyPay = newMonthlyPay;
    employee.salaryAdjustments.push({
      previousPay,
      increaseAmount: roundMoney(increaseAmount),
      newMonthlyPay,
      effectiveDate,
      note,
    });

    await employee.save();

    return sendSuccess(res, {
      employee: formatEmployeeSummary(employee),
      adjustment: employee.salaryAdjustments[employee.salaryAdjustments.length - 1],
    }, "Pay increased", 201);
  } catch (err) {
    console.error("Error increasing employee pay:", err);
    return sendError(res, "Error increasing employee pay", 500);
  }
});

app.post("/api/hr/employees/:id/settlement-preview", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employee = await HrEmployee.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!employee) {
      return sendError(res, "Employee not found", 404);
    }

    if ((employee.employmentStatus || "active") === "left") {
      return sendError(res, "This employee has left and cannot be settled again", 400);
    }

    const settlementDate = parseDateToPKR(req.body.settlementDate || curdate());
    const settlementValidation = validateSettlementDateWindow(employee, settlementDate);
    if (!settlementValidation.valid) {
      return sendError(res, settlementValidation.message, 400, {
        settlementDate,
        lastSettlementDate: employee.lastSettlementDate || employee.joiningDate,
        today: curdate(),
      });
    }
    const snapshot = getEmployeeSettlementSnapshot(employee, settlementDate);

    return sendSuccess(res, {
      employee: {
        id: employee._id,
        name: employee.name,
        monthlyPay: employee.monthlyPay,
        joiningDate: employee.joiningDate,
        lastSettlementDate: employee.lastSettlementDate,
      },
      snapshot,
      transactions: snapshot.eligibleTransactions,
    }, "Settlement preview created");
  } catch (err) {
    console.error("Error creating HR settlement preview:", err);
    return sendError(res, "Error creating settlement preview", 500);
  }
});

app.post("/api/hr/employees/:id/settle", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employee = await HrEmployee.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!employee) {
      return sendError(res, "Employee not found", 404);
    }

    if ((employee.employmentStatus || "active") === "left") {
      return sendError(res, "This employee has left and cannot be settled again", 400);
    }

    const settlementDate = parseDateToPKR(req.body.settlementDate || curdate());
    const settlementValidation = validateSettlementDateWindow(employee, settlementDate);
    if (!settlementValidation.valid) {
      return sendError(res, settlementValidation.message, 400, {
        settlementDate,
        lastSettlementDate: employee.lastSettlementDate || employee.joiningDate,
        today: curdate(),
      });
    }
    const snapshot = getEmployeeSettlementSnapshot(employee, settlementDate);
    const netBalance = Number(snapshot.netPay || 0);

    if (Math.abs(netBalance) > 0.000001) {
      const dueType = netBalance > 0 ? "owner_due" : "employee_due";
      const dueAmount = roundMoney(Math.abs(netBalance));
      const dueMessage = netBalance > 0
        ? `Not clear dues: owner has to pay ${dueAmount} PKR before settlement.`
        : `Not clear dues: employee has to clear ${dueAmount} PKR before settlement.`;

      return sendError(res, dueMessage, 400, {
        netBalance,
        dueType,
        dueAmount,
        settlementDate,
      });
    }

    const settlementDoc = employee.settlements.create({
      settlementDate,
      daysWorked: snapshot.daysWorked,
      dailyRate: snapshot.dailyRate,
      basePay: snapshot.basePay,
      advancesTotal: snapshot.advancesTotal,
      paybacksTotal: snapshot.paybacksTotal,
      netPay: snapshot.netPay,
      transactionCount: snapshot.eligibleTransactions.length,
      approvedAt: new Date(),
      executedAt: new Date(),
    });

    employee.transactions = (employee.transactions || []).map((transaction) => {
      const transactionYmd = pkrDateToYmd(transaction.transactionDate);
      const startYmd = pkrDateToYmd(snapshot.lastSettlementDate);
      const endYmd = pkrDateToYmd(settlementDate);
      const inWindow = !transaction.settledAt && transactionYmd >= startYmd && transactionYmd <= endYmd;

      if (inWindow) {
        return {
          ...transaction.toObject(),
          settledAt: new Date(),
          settlementId: settlementDoc._id,
        };
      }

      return transaction;
    });

    employee.settlements.push(settlementDoc);
    employee.lastSettlementDate = settlementDate;

    await employee.save();

    return sendSuccess(res, {
      employee: formatEmployeeSummary(employee, settlementDate),
      settlement: employee.settlements[employee.settlements.length - 1],
    }, "Settlement executed", 201);
  } catch (err) {
    console.error("Error executing HR settlement:", err);
    return sendError(res, "Error executing settlement", 500);
  }
});

app.post("/api/hr/employees/:id/mark-left", requireAdmin, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const employee = await HrEmployee.findOne(addTenantScope({ _id: req.params.id }, tenantScope));
    if (!employee) {
      return sendError(res, "Employee not found", 404);
    }

    if ((employee.employmentStatus || "active") === "left") {
      return sendError(res, "Employee is already marked as left", 400);
    }

    const leftDate = parseDateToPKR(req.body.leftDate || curdate());
    const leftDateValidation = validateLeftDateWindow(employee, leftDate);
    if (!leftDateValidation.valid) {
      return sendError(res, leftDateValidation.message, 400, {
        leftDate,
        joiningDate: employee.joiningDate,
        lastSettlementDate: employee.lastSettlementDate || employee.joiningDate,
        today: curdate(),
      });
    }

    const snapshot = getEmployeeSettlementSnapshot(employee, leftDate);
    const netBalance = Number(snapshot.netPay || 0);
    if (Math.abs(netBalance) > 0.000001) {
      const dueType = netBalance > 0 ? "owner_due" : "employee_due";
      const dueAmount = roundMoney(Math.abs(netBalance));
      const dueMessage = netBalance > 0
        ? `Not clear dues: owner has to pay ${dueAmount} PKR before marking employee as left.`
        : `Not clear dues: employee has to clear ${dueAmount} PKR before marking employee as left.`;

      return sendError(res, dueMessage, 400, {
        netBalance,
        dueType,
        dueAmount,
        settlementDate: leftDate,
      });
    }

    employee.employmentStatus = "left";
    employee.leftDate = leftDate;
    employee.payAtLeaving = roundMoney(employee.monthlyPay);
    employee.netBalanceAtLeaving = 0;

    await employee.save();

    return sendSuccess(res, {
      employee: formatLeftEmployeeSummary(employee),
    }, "Employee marked as left");
  } catch (err) {
    console.error("Error marking employee as left:", err);
    return sendError(res, "Error marking employee as left", 500);
  }
});

app.get(["/api/records", "/view"], requireAuth, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    const today = new Date();
    let month = req.query.month ? parseInt(req.query.month, 10) : today.getMonth() + 1;
    let year = req.query.year ? parseInt(req.query.year, 10) : today.getFullYear();

    if (month < 1) {
      month = 12;
      year -= 1;
    } else if (month > 12) {
      month = 1;
      year += 1;
    }

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    const formattedStartDate = formatDateToYMD(startDate);
    const formattedEndDate = formatDateToYMD(endDate);

    const allRecords = await Submission.find(addTenantScope({}, tenantScope));
    const entries = allRecords.filter((record) => {
      const [day, dbMonth, dbYear] = record.date.split("/");
      const recordDate = formatDateToYMD(new Date(dbYear, dbMonth - 1, day));
      return recordDate >= formattedStartDate && recordDate <= formattedEndDate;
    });

    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;

    const nextMonthDate = new Date(nextYear, nextMonth - 1, 1);
    const canGoToNextMonth = nextMonthDate <= today;

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];

    return sendSuccess(res, {
      entries,
      currentMonth: month,
      currentYear: year,
      monthDisplay: monthNames[month - 1],
      prevMonth,
      prevYear,
      nextMonth,
      nextYear,
      canGoToNextMonth,
      user: {
        name: req.user.name,
        role: req.user.role,
      },
      tenant: {
        code: tenantScope.tenantCode,
      },
      date: curdate(),
    }, "Records fetched");
  } catch (err) {
    console.error("Error fetching records:", err);
    return sendError(res, "Error fetching records", 500);
  }
});

app.get(["/api/records/:date", "/individualRec/:date", "/update/:date"], requireAuth, async (req, res) => {
  const decodedDate = decodeURIComponent(req.params.date);

  try {
    const tenantScope = getRequestTenantScope(req);
    const entry = await Submission.findOne(addTenantScope({ date: decodedDate }, tenantScope));
    if (!entry) {
      return sendError(res, "Record not found", 404);
    }

    return sendSuccess(res, {
      entry,
      date: decodedDate,
      postingDate: encodeURIComponent(decodedDate),
      user: {
        name: req.user.name,
        role: req.user.role,
      },
      tenant: {
        code: tenantScope.tenantCode,
      },
    }, "Record fetched");
  } catch (err) {
    console.log(err);
    return sendError(res, "Something went wrong while fetching record", 500);
  }
});

app.post(["/api/records", "/submit"], requireAdmin, async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const morningMilk = req.body.morningMilk;
  const eveningMilk = req.body.eveningMilk;
  const expensesArray = normalizeAmounts(req.body.expenses);
  const revenuesArray = normalizeAmounts(req.body.revenues);

  const selectedDate = req.body.recordDate;
  const currentDate = selectedDate || curdate();

  const existingSubmission = await Submission.findOne(addTenantScope({ date: currentDate }, tenantScope));
  if (existingSubmission) {
    const existingExpenses = existingSubmission.expenses || [];
    const existingRevenues = existingSubmission.revenues || [];
    const hasManualExpenses = existingExpenses.some((item) => !isReadonlyDailyLineItem(item));
    const hasManualRevenues = existingRevenues.some((item) => !isReadonlyDailyLineItem(item));
    const hasManualMilk = Number(existingSubmission.morningMilkQuantity || 0) > 0
      || Number(existingSubmission.eveningMilkQuantity || 0) > 0;

    if (hasManualExpenses || hasManualRevenues || hasManualMilk) {
      return sendError(res, `A record already exists for date ${currentDate}`, 409);
    }
  }

  const currentMilkPrice = Number(existingSubmission?.milkPrice ?? milkPrice);
  const manualExpenses = normalizeEditableLineItems(expensesArray);
  const manualRevenues = normalizeEditableLineItems(revenuesArray);
  const readonlyExpenses = normalizeReadonlyLineItems(existingSubmission?.expenses || []);
  const readonlyRevenues = normalizeReadonlyLineItems(existingSubmission?.revenues || []);
  const mergedExpenses = [...manualExpenses, ...readonlyExpenses];
  const mergedRevenues = [...manualRevenues, ...readonlyRevenues];
  const totals = calculateRecordTotals(morningMilk, eveningMilk, currentMilkPrice, mergedExpenses, mergedRevenues);

  const submissionPayload = {
    tenantId: tenantScope.tenantId,
    tenantCode: tenantScope.tenantCode,
    date: currentDate,
    morningMilkQuantity: Number(morningMilk || 0),
    eveningMilkQuantity: Number(eveningMilk || 0),
    milkPrice: currentMilkPrice,
    expenses: mergedExpenses,
    revenues: mergedRevenues,
    totalRevenue: totals.totalRevenue,
    totalExpenditure: totals.totalExpenses,
    Balance: totals.balance,
  };

  try {
    let savedSubmission;
    if (existingSubmission) {
      savedSubmission = await Submission.findOneAndUpdate(addTenantScope({ date: currentDate }, tenantScope), submissionPayload, { new: true });
    } else {
      const newSubmission = new Submission(submissionPayload);
      savedSubmission = await newSubmission.save();
    }

    markMonthlyReportsDirty(monthKeyFromPkrDateString(currentDate), tenantScope);
    await ensureMonthlyReportsUpToDate(tenantScope);

    return sendSuccess(res, {
      date: currentDate,
      submission: savedSubmission,
    }, "Record inserted", 201);
  } catch (error) {
    console.error("Error submitting form:", error);
    return sendError(res, "Error submitting record", 500);
  }
});

app.post(["/api/records/check-new-date", "/update/new/check-date"], requireAdmin, async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const rawDate = req.body.date;
  const selectedDate = formatDateToPKR(rawDate);
  const { minDate, maxDate } = getCurrentMonthInputRange();

  if (!selectedDate || selectedDate === "Invalid Date") {
    return sendError(res, "Invalid date selected", 400, {
      selectedDateInput: rawDate,
    });
  }

  if (!isCurrentMonthDate(selectedDate)) {
    return sendError(res, "Only current month date is allowed for new record insertion", 400, {
      minDate,
      maxDate,
      selectedDateInput: rawDate,
    });
  }

  try {
    const existingSubmission = await Submission.findOne(addTenantScope({ date: selectedDate }, tenantScope));
    if (existingSubmission) {
      return sendError(res, `A record already exists for date ${selectedDate}`, 409);
    }

    return sendSuccess(res, {
      minDate,
      maxDate,
      selectedDateInput: rawDate,
      selectedDate,
    }, "Date is available");
  } catch (err) {
    console.log(err);
    return sendError(res, "Something went wrong while checking date", 500);
  }
});

app.post(["/api/records/resolve-date", "/datetoUpdate"], requireAdmin, async (req, res) => {
  const tenantScope = getRequestTenantScope(req);
  const date = req.body.date;
  const formattedDate = formatDateToPKR(date);

  try {
    const entry = await Submission.findOne(addTenantScope({ date: formattedDate }, tenantScope));
    if (!entry) {
      return sendError(res, "No entry exists for the given date", 404);
    }

    return sendSuccess(res, {
      requestedDate: date,
      formattedDate,
      encodedDate: encodeURIComponent(formattedDate),
    }, "Date resolved");
  } catch (err) {
    return sendError(res, "Something went wrong while resolving date", 500);
  }
});

app.put("/api/records/:date", requireAdmin, async (req, res) => {
  const decodedDate = decodeURIComponent(req.params.date);
  return updateRecordHandler(req, res, decodedDate);
});

app.post("/update/:date", requireAdmin, async (req, res) => {
  const decodedDate = decodeURIComponent(req.params.date);
  return updateRecordHandler(req, res, decodedDate);
});

app.get(["/api/reports/months", "/getmonths"], requireAuth, async (req, res) => {
  try {
    const tenantScope = getRequestTenantScope(req);
    await ensureMonthlyReportsUpToDate(tenantScope);
    const months = await MonthlyReport.find(addTenantScope({}, tenantScope));
    const formattedMonths = months.map((month) => formatMonth(month.month));

    return sendSuccess(res, {
      months: formattedMonths,
      rawMonths: months,
      user: {
        name: req.user.name,
        role: req.user.role,
      },
      tenant: {
        code: tenantScope.tenantCode,
      },
      date: curdate(),
    }, "Month list fetched");
  } catch (err) {
    console.error("Error fetching months:", err);
    return sendError(res, "Error fetching months", 500);
  }
});

app.get(["/api/reports/:month", "/getrep/:month"], requireAuth, async (req, res) => {
  const monthYear = req.params.month;
  const formattedMonth = convertToMonthYear(monthYear);

  if (!formattedMonth) {
    return sendError(res, "Invalid month format. Use 'Month YYYY' or 'MM-YYYY'", 400);
  }

  const [month, year] = formattedMonth.split("-");
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);

  const formattedStartDate = formatDateToYMD(startDate);
  const formattedEndDate = formatDateToYMD(endDate);

  try {
    const tenantScope = getRequestTenantScope(req);
    await ensureMonthlyReportsUpToDate(tenantScope);
    const records = await Submission.find(addTenantScope({}, tenantScope));
    const filteredRecords = records.filter((record) => {
      const [day, dbMonth, dbYear] = record.date.split("/");
      const recordDate = `${dbYear}-${String(dbMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return recordDate >= formattedStartDate && recordDate <= formattedEndDate;
    });

    const monthlyRecord = await MonthlyReport.findOne(addTenantScope({ month: formattedMonth }, tenantScope));

    return sendSuccess(res, {
      month,
      year,
      records: filteredRecords,
      monthlyRep: monthlyRecord,
      user: {
        name: req.user.name,
        role: req.user.role,
      },
      tenant: {
        code: tenantScope.tenantCode,
      },
      date: new Date().toLocaleDateString(),
    }, "Monthly report fetched");
  } catch (err) {
    console.error("Error fetching records for month:", err);
    return sendError(res, "Error fetching records for selected month", 500);
  }
});

app.get(["/update", "/update/existing", "/update/new"], requireAdmin, (req, res) => {
  return sendSuccess(res, {
    deprecated: true,
    message: "Use /api/records and /api/records/check-new-date endpoints",
    range: getCurrentMonthInputRange(),
  }, "Legacy route kept for compatibility");
});

app.get("/api/superadmin/farms", requireSuperadmin, async (req, res) => {
  try {
    const tenants = await Tenant.find({}).sort({ createdAt: -1 });

    const farms = [];
    for (const tenant of tenants) {
      const status = getTenantStatus(tenant);

      farms.push({
        id: tenant._id,
        name: tenant.name,
        code: tenant.code,
        isActive: Boolean(tenant.isActive),
        isActiveNow: Boolean(status.isActiveNow),
        inactiveUntil: tenant.inactiveUntil,
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
      });
    }

    return sendSuccess(res, { farms }, "Farm tenants fetched");
  } catch (err) {
    console.error("Error fetching farm tenants:", err);
    return sendError(res, "Unable to fetch farm tenants", 500);
  }
});

app.post("/api/superadmin/farms", requireSuperadmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const code = normalizeTenantCode(req.body.code);
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!name || !code || !email || !password) {
    return sendError(res, "Farm name, tenant code, admin email, and password are required", 400);
  }

  try {
    const existingTenant = await Tenant.findOne({ code }).lean();
    if (existingTenant) {
      return sendError(res, "Tenant code already exists", 409);
    }

    const tenant = await Tenant.create({
      name,
      code,
      isActive: true,
    });

    try {
      await User.create({
        name: `${name} Admin`,
        email,
        password,
        role: "admin",
        tenantId: tenant._id,
        tenantCode: tenant.code,
      });
    } catch (userErr) {
      await Tenant.deleteOne({ _id: tenant._id });

      if (userErr && typeof userErr === "object" && userErr.code === 11000) {
        return sendError(res, "Admin user already exists for this tenant", 409);
      }

      throw userErr;
    }

    return sendSuccess(res, {
      farm: {
        id: tenant._id,
        name: tenant.name,
        code: tenant.code,
        isActive: Boolean(tenant.isActive),
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
      },
    }, "Farm tenant created", 201);
  } catch (err) {
    console.error("Error creating farm tenant:", err);
    return sendError(res, "Unable to create farm tenant", 500);
  }
});

app.patch("/api/superadmin/farms/:id/status", requireSuperadmin, async (req, res) => {
  const isActive = Boolean(req.body.isActive);
  const inactiveUntilInput = req.body.inactiveUntil ? new Date(req.body.inactiveUntil) : null;
  const inactiveUntil = inactiveUntilInput && !Number.isNaN(inactiveUntilInput.getTime()) ? inactiveUntilInput : null;

  try {
    const tenant = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        isActive,
        inactiveUntil: isActive ? inactiveUntil : null,
      },
      { new: true },
    );

    if (!tenant) {
      return sendError(res, "Farm tenant not found", 404);
    }

    return sendSuccess(res, {
      farm: {
        id: tenant._id,
        name: tenant.name,
        code: tenant.code,
        isActive: Boolean(tenant.isActive),
        isActiveNow: Boolean(getTenantStatus(tenant).isActiveNow),
        inactiveUntil: tenant.inactiveUntil,
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
      },
    }, "Farm tenant status updated");
  } catch (err) {
    console.error("Error updating farm tenant status:", err);
    return sendError(res, "Unable to update farm tenant status", 500);
  }
});

app.delete("/api/superadmin/farms/:id", requireSuperadmin, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) {
      return sendError(res, "Farm tenant not found", 404);
    }

    await Promise.all([
      User.deleteMany({ tenantId: tenant._id, tenantCode: tenant.code }),
      HrEmployee.deleteMany({ tenantId: tenant._id, tenantCode: tenant.code }),
      Submission.deleteMany({ tenantId: tenant._id, tenantCode: tenant.code }),
      MonthlyReport.deleteMany({ tenantId: tenant._id, tenantCode: tenant.code }),
      Tenant.deleteOne({ _id: tenant._id }),
    ]);

    return sendSuccess(res, null, "Farm tenant deleted");
  } catch (err) {
    console.error("Error deleting farm tenant:", err);
    return sendError(res, "Unable to delete farm tenant", 500);
  }
});

app.get("/api/superadmin/report", requireSuperadmin, async (req, res) => {
  try {
    const [
      tenants,
      totalUsers,
      totalAdmins,
      totalSuperadmins,
      totalSubmissions,
      totalHrEmployees,
      totalMonthlyReports,
    ] = await Promise.all([
      Tenant.find({}).lean(),
      User.countDocuments({}),
      User.countDocuments({ role: "admin" }),
      User.countDocuments({ role: "superadmin" }),
      Submission.countDocuments({}),
      HrEmployee.countDocuments({}),
      MonthlyReport.countDocuments({}),
    ]);

    const activeFarms = tenants.filter((tenant) => getTenantStatus(tenant).isActiveNow).length;

    return sendSuccess(res, {
      totalFarms: tenants.length,
      activeFarms,
      inactiveFarms: tenants.length - activeFarms,
      totalUsers,
      totalAdmins,
      totalSuperadmins,
      totalUserLogs: totalUsers,
      totalSubmissions,
      totalHrEmployees,
      totalMonthlyReports,
    }, "Superadmin report fetched");
  } catch (err) {
    console.error("Error fetching superadmin report:", err);
    return sendError(res, "Unable to fetch superadmin report", 500);
  }
});

app.get("/api/superadmin/farms/:code/overview", requireSuperadmin, async (req, res) => {
  const tenantCode = normalizeTenantCode(req.params.code);
  if (!tenantCode) {
    return sendError(res, "Invalid tenant code", 400);
  }

  try {
    const tenant = await Tenant.findOne({ code: tenantCode }).lean();
    if (!tenant) {
      return sendError(res, "Tenant not found", 404);
    }

    const tenantScope = {
      tenantId: tenant._id,
      tenantCode: tenant.code,
    };

    const [
      usersCount,
      recordsCount,
      hrEmployeesCount,
      monthlyReportsCount,
      latestRecords,
    ] = await Promise.all([
      User.countDocuments({ tenantId: tenant._id, tenantCode: tenant.code }),
      Submission.countDocuments(addTenantScope({}, tenantScope)),
      HrEmployee.countDocuments(addTenantScope({}, tenantScope)),
      MonthlyReport.countDocuments(addTenantScope({}, tenantScope)),
      Submission.find(addTenantScope({}, tenantScope)).sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    return sendSuccess(res, {
      farm: {
        id: tenant._id,
        name: tenant.name,
        code: tenant.code,
        isActive: tenant.isActive,
        isActiveNow: getTenantStatus(tenant).isActiveNow,
        inactiveUntil: tenant.inactiveUntil,
      },
      totals: {
        usersCount,
        recordsCount,
        hrEmployeesCount,
        monthlyReportsCount,
      },
      latestRecords,
    }, "Farm overview fetched");
  } catch (err) {
    console.error("Error fetching farm overview:", err);
    return sendError(res, "Unable to fetch farm overview", 500);
  }
});

app.get("/contact", requireAuth, (req, res) => {
  return sendSuccess(res, {
    role: req.user.role,
    contact: {
      message: "Contact page moved to frontend client.",
    },
  }, "Contact payload fetched");
});

app.use((req, res) => {
  return sendError(res, "Route not found", 404);
});

app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
