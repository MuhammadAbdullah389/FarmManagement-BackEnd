require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");

const conn = require("./controllers/connecttoDB");
const curdate = require("./controllers/currentdate");
const Submission = require("./models/dailyRecord");
const MonthlyReport = require("./models/monthlyRecord");
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

function requireAuth(req, res, next) {
  if (!req.user) {
    return sendError(res, "Authentication required", 401);
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return sendError(res, "Authentication required", 401);
  }
  if (req.user.role !== "admin") {
    return sendError(res, "Admin access required", 403);
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

async function updateRecordHandler(req, res, decodedDate) {
  const { morningMilk, eveningMilk, expenses, revenues } = req.body;
  const expensesArray = normalizeAmounts(expenses);
  const revenuesArray = normalizeAmounts(revenues);

  try {
    const oldEntry = await Submission.findOne({ date: decodedDate });
    if (!oldEntry) {
      return sendError(res, "Record not found", 404);
    }

    const currentMilkPrice = oldEntry?.milkPrice ?? milkPrice;
    const milkRevenue = (+morningMilk + +eveningMilk) * currentMilkPrice;
    const totalExpenses = expensesArray.reduce((sum, expense) => sum + expense.amount, 0);
    const totalRevenue = revenuesArray.reduce((sum, revenue) => sum + revenue.amount, 0) + milkRevenue;
    const balance = totalRevenue - totalExpenses;

    const updatedEntry = await Submission.findOneAndUpdate(
      { date: decodedDate },
      {
        morningMilkQuantity: morningMilk,
        eveningMilkQuantity: eveningMilk,
        milkPrice: currentMilkPrice,
        expenses: expensesArray,
        revenues: revenuesArray,
        totalRevenue,
        totalExpenditure: totalExpenses,
        Balance: balance,
      },
      { new: true }
    );

    const oldBalance = oldEntry.Balance || 0;
    const [day, month, year] = decodedDate.split("/");
    const currentMonthStr = `${String(Number(month)).padStart(2, "0")}-${year}`;
    const currentMonthReport = await MonthlyReport.findOne({ month: currentMonthStr });

    if (currentMonthReport) {
      currentMonthReport.netBalance = currentMonthReport.netBalance - oldBalance + balance;
      currentMonthReport.closingBalance = currentMonthReport.openingBalance + currentMonthReport.netBalance;
      await currentMonthReport.save();
    }

    return sendSuccess(res, { date: decodedDate, updatedEntry }, "Record updated");
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

app.use((req, res, next) => {
  const allowedOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

app.get("/api/health", (req, res) => {
  return sendSuccess(res, { up: true, date: curdate() }, "Server is running");
});

app.get(["/", "/home"], requireAuth, async (req, res) => {
  try {
    const entry = await Submission.findOne({ date: curdate() });
    return sendSuccess(res, {
      user: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
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
  const { email, password } = req.body;
  const user = await verifyUser(email, password);

  if (!user) {
    return sendError(res, "Invalid credentials", 401);
  }

  const token = setUser(user);
  const oneMonth = 30 * 24 * 60 * 60 * 1000;

  res.cookie("tId", token, {
    expires: new Date(Date.now() + oneMonth),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return sendSuccess(res, {
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  }, "Login successful");
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  return sendSuccess(res, {
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
    },
  }, "Authenticated user fetched");
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("tId");
  return sendSuccess(res, null, "Logged out");
});

app.get("/logout", (req, res) => {
  res.clearCookie("tId");
  return sendSuccess(res, { deprecated: true }, "Logged out");
});

app.get(["/api/records", "/view"], requireAuth, async (req, res) => {
  try {
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

    const allRecords = await Submission.find({});
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
    const entry = await Submission.findOne({ date: decodedDate });
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
    }, "Record fetched");
  } catch (err) {
    console.log(err);
    return sendError(res, "Something went wrong while fetching record", 500);
  }
});

app.post(["/api/records", "/submit"], requireAdmin, async (req, res) => {
  const morningMilk = req.body.morningMilk;
  const eveningMilk = req.body.eveningMilk;
  const expensesArray = normalizeAmounts(req.body.expenses);
  const revenuesArray = normalizeAmounts(req.body.revenues);

  const milkRevenue = (+morningMilk + +eveningMilk) * milkPrice;
  const totalExpenses = expensesArray.reduce((sum, expense) => sum + expense.amount, 0);
  const totalRevenue = revenuesArray.reduce((sum, revenue) => sum + revenue.amount, 0) + milkRevenue;
  const balance = totalRevenue - totalExpenses;

  const selectedDate = req.body.recordDate;
  const currentDate = selectedDate || curdate();

  const existingSubmission = await Submission.findOne({ date: currentDate });
  if (existingSubmission) {
    return sendError(res, `A record already exists for date ${currentDate}`, 409);
  }

  const newSubmission = new Submission({
    date: currentDate,
    morningMilkQuantity: morningMilk,
    eveningMilkQuantity: eveningMilk,
    milkPrice,
    expenses: expensesArray,
    revenues: revenuesArray,
    totalRevenue,
    totalExpenditure: totalExpenses,
    Balance: balance,
  });

  const [day, month, year] = currentDate.split("/");
  const entryDateObj = new Date(year, month - 1, day);
  const currentMonth = entryDateObj.getMonth() + 1;
  const currentYear = entryDateObj.getFullYear();
  const currentMonthStr = `${String(currentMonth).padStart(2, "0")}-${currentYear}`;

  const previousMonthStr = currentMonth === 1
    ? `12-${currentYear - 1}`
    : `${String(currentMonth - 1).padStart(2, "0")}-${currentYear}`;

  const previousMonthReport = await MonthlyReport.findOne({ month: previousMonthStr });
  const previousMonthClosingBalance = previousMonthReport ? previousMonthReport.closingBalance : 0;

  let currentMonthReport = await MonthlyReport.findOne({ month: currentMonthStr });

  const options = { day: "2-digit", month: "2-digit", year: "numeric" };
  const startDate = new Date(currentYear, currentMonth - 1, 1);
  const endDate = new Date(currentYear, currentMonth, 0);

  const startDateFormatted = startDate.toLocaleDateString("en-GB", options);
  const endDateFormatted = endDate.toLocaleDateString("en-GB", options);

  if (!currentMonthReport) {
    currentMonthReport = new MonthlyReport({
      month: currentMonthStr,
      openingBalance: previousMonthClosingBalance,
      netBalance: balance,
      closingBalance: previousMonthClosingBalance + balance,
      startDate: startDateFormatted,
      endDate: endDateFormatted,
    });
  } else {
    currentMonthReport.netBalance += balance;
    currentMonthReport.closingBalance = currentMonthReport.openingBalance + currentMonthReport.netBalance;
  }

  try {
    await currentMonthReport.save();
    await newSubmission.save();

    return sendSuccess(res, {
      date: currentDate,
      submission: newSubmission,
    }, "Record inserted", 201);
  } catch (error) {
    console.error("Error submitting form:", error);
    return sendError(res, "Error submitting record", 500);
  }
});

app.post(["/api/records/check-new-date", "/update/new/check-date"], requireAdmin, async (req, res) => {
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
    const existingSubmission = await Submission.findOne({ date: selectedDate });
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
  const date = req.body.date;
  const formattedDate = formatDateToPKR(date);

  try {
    const entry = await Submission.findOne({ date: formattedDate });
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
    const months = await MonthlyReport.find();
    const formattedMonths = months.map((month) => formatMonth(month.month));

    return sendSuccess(res, {
      months: formattedMonths,
      rawMonths: months,
      user: {
        name: req.user.name,
        role: req.user.role,
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
    const records = await Submission.find({});
    const filteredRecords = records.filter((record) => {
      const [day, dbMonth, dbYear] = record.date.split("/");
      const recordDate = `${dbYear}-${String(dbMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return recordDate >= formattedStartDate && recordDate <= formattedEndDate;
    });

    const monthlyRecord = await MonthlyReport.findOne({ month: formattedMonth });

    return sendSuccess(res, {
      month,
      year,
      records: filteredRecords,
      monthlyRep: monthlyRecord,
      user: {
        name: req.user.name,
        role: req.user.role,
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
