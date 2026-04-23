const mongoose = require("mongoose");

const tenantSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: /^(ALPHA|BETA|CHARLIE|DELTA)-\d{3}$/,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    inactiveUntil: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

const Tenant = mongoose.model("Tenant", tenantSchema);

module.exports = Tenant;
