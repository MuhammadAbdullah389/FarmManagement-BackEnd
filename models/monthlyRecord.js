const mongoose = require('mongoose');

const monthlyReportSchema = new mongoose.Schema({
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
  month: {
    type: String,
    required: true,
  },

  openingBalance: {
    type: Number,
    required: true, 
  },

  netBalance: {
    type: Number,
    required: true, 
  },

  closingBalance: {
    type: Number,
    required: true, 
  },

  startDate: {
    type: String,
    required: true, 
  },

  endDate: {
    type: String,
    required: true, 
  },

  createdAt: {
    type: Date,
    default: Date.now, // Timestamp of when the document was created or updated
  }

});

monthlyReportSchema.index({ tenantId: 1, month: 1 }, { unique: true });

const MonthlyReport = mongoose.model('MonthlyReport', monthlyReportSchema);

module.exports = MonthlyReport;
