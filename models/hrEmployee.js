const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ["advance", "payback"],
    },
    amount: {
      type: Number,
      required: true,
    },
    note: {
      type: String,
      default: "",
    },
    transactionDate: {
      type: String,
      required: true,
    },
    settledAt: {
      type: Date,
      default: null,
    },
    settlementId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { _id: true, timestamps: true },
);

const settlementSchema = new mongoose.Schema(
  {
    settlementDate: {
      type: String,
      required: true,
    },
    daysWorked: {
      type: Number,
      required: true,
    },
    dailyRate: {
      type: Number,
      required: true,
    },
    basePay: {
      type: Number,
      required: true,
    },
    advancesTotal: {
      type: Number,
      required: true,
    },
    paybacksTotal: {
      type: Number,
      required: true,
    },
    netPay: {
      type: Number,
      required: true,
    },
    transactionCount: {
      type: Number,
      required: true,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    executedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: true, timestamps: true },
);

const salaryAdjustmentSchema = new mongoose.Schema(
  {
    previousPay: {
      type: Number,
      required: true,
    },
    increaseAmount: {
      type: Number,
      required: true,
    },
    newMonthlyPay: {
      type: Number,
      required: true,
    },
    effectiveDate: {
      type: String,
      required: true,
    },
    note: {
      type: String,
      default: "",
    },
  },
  { _id: true, timestamps: true },
);

const hrEmployeeSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    tenantCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    monthlyPay: {
      type: Number,
      required: true,
    },
    joiningDate: {
      type: String,
      required: true,
    },
    lastSettlementDate: {
      type: String,
      default: null,
    },
    employmentStatus: {
      type: String,
      enum: ["active", "left"],
      default: "active",
    },
    leftDate: {
      type: String,
      default: null,
    },
    payAtLeaving: {
      type: Number,
      default: null,
    },
    netBalanceAtLeaving: {
      type: Number,
      default: 0,
    },
    transactions: {
      type: [transactionSchema],
      default: [],
    },
    settlements: {
      type: [settlementSchema],
      default: [],
    },
    salaryAdjustments: {
      type: [salaryAdjustmentSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

hrEmployeeSchema.index({ tenantId: 1, name: 1 });

const HrEmployee = mongoose.model("HrEmployee", hrEmployeeSchema);

module.exports = HrEmployee;