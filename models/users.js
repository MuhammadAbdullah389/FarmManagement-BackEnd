const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name : {
        type : String,
        required : true,
    },
    email : {
        type : String,
        required : true,
    },
    password : {
        type : String,
        required : true,
    },
    role : {
        type : String,
        required : true,
        enum : ["user", "admin", "superadmin"],
        default : "user"
    },
    tenantId: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
        index: true,
    },
    tenantCode: {
        type: String,
        default: null,
        uppercase: true,
        trim: true,
    },
});

userSchema.index({ email: 1, tenantCode: 1 }, { unique: true, sparse: true });

const User = mongoose.model("UserLogs" , userSchema);

module.exports = User;