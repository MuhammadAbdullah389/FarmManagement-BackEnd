const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema({
    description: {
        type: String,
        required: true,
    },
    amount: {
        type: Number,
        required: true,
    },
    readonly: {
        type: Boolean,
        default: false,
    },
    source: {
        type: String,
        default: "manual",
    },
    sourceRefType: {
        type: String,
        default: null,
    },
    sourceRefId: {
        type: String,
        default: null,
    },
}, { _id: false });

const submissionSchema = new mongoose.Schema({
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
    date: { 
        type: String, 
        required: true
    },
    morningMilkQuantity: { 
        type: Number, 
        required: true 
    },
    eveningMilkQuantity: { 
        type: Number, 
        required: true 
    },
    milkPrice: { 
        type: Number, 
        required: true 
    },
    expenses: [lineItemSchema],
    revenues: [lineItemSchema],
    totalRevenue : {
        type: Number, 
        required: true         
    },
    totalExpenditure : {
        type: Number, 
        required: true 
    },
    Balance : {
        type: Number, 
        required: true 
    }
}, 
{
    timestamps: true,
}
);

submissionSchema.index({ tenantId: 1, date: 1 }, { unique: true });

const Submission = mongoose.model('Submission', submissionSchema);

module.exports = Submission;
