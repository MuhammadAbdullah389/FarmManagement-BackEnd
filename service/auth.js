const jwt = require("jsonwebtoken");

const setUser = (user) => {
    return jwt.sign({
        _id : user._id,
        name : user.name,
        email : user.email,
        role : user.role,
        tenantId: user.tenantId || null,
        tenantCode: user.tenantCode || null,
        tenantName: user.tenantName || null,
        tenantIsActive: typeof user.tenantIsActive === "boolean" ? user.tenantIsActive : null,
        tenantSubscriptionExpiresAt: user.tenantSubscriptionExpiresAt || null,
    } , process.env.SECRET_KEY);
}

const getUser = (token) => {
    const vToken = jwt.verify(token , process.env.SECRET_KEY);
    return vToken;
}

module.exports = {
    setUser,
    getUser
}