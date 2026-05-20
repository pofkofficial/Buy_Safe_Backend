// middleware/validation.js — Buy Safe (Joi)
const Joi = require('joi');

const validate = (schema, source = 'body') => (req, res, next) => {
  const target = source === 'query' ? req.query : req.body;
  const { error, value } = schema.validate(target, { abortEarly: false, stripUnknown: true, convert: true });
  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors:  error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
    });
  }
  if (source === 'query') req.query = value;
  else req.body = value;
  next();
};

exports.validateGoogleAuth = validate(Joi.object({
  idToken: Joi.string().required(),
}));

exports.validateAppleAuth = validate(Joi.object({
  identityToken:     Joi.string().required(),
  authorizationCode: Joi.string().optional(),
  fullName: Joi.object({
    givenName:  Joi.string().allow('', null).optional(),
    familyName: Joi.string().allow('', null).optional(),
  }).optional(),
}));

exports.validateSetUsername = validate(Joi.object({
  username: Joi.string()
    .trim()
    .lowercase()
    .min(3)
    .max(30)
    .pattern(/^[a-z0-9_.]+$/)
    .required()
    .messages({
      'string.pattern.base': 'Username can only contain letters, numbers, dots, and underscores.',
      'string.min': 'Username must be at least 3 characters.',
      'string.max': 'Username cannot exceed 30 characters.',
    }),
}));

exports.validateCreateOrder = validate(Joi.object({
  itemName: Joi.string().trim().min(2).max(120)
    .pattern(/^[\w\s\-'',().&]+$/)
    .required()
    .messages({ 'string.pattern.base': 'Item name contains unsupported characters.' }),

  itemDescription: Joi.string().trim().max(500).optional().allow(''),

  itemPriceGHS: Joi.number().min(1).max(100000).precision(2).required()
    .messages({ 'number.min': 'Minimum transaction is GHS 1.00.' }),

  receiverUsername: Joi.string().trim().lowercase().min(3).max(30).required(),
}));

exports.validateReview = validate(Joi.object({
  rating:  Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().max(300).optional().allow(''),
}));

exports.validateReject = validate(Joi.object({
  reason: Joi.string().trim().max(300).optional().allow(''),
}));

exports.validateUpdateProfile = validate(Joi.object({
  displayName: Joi.string().trim().min(1).max(80).optional(),
  bio:         Joi.string().trim().max(160).optional().allow(''),
  avatarUrl:   Joi.string().uri().optional().allow('', null),
}));

exports.validateVerifyAccount = validate(Joi.object({
  accountNumber: Joi.string().pattern(/^0\d{9}$/).required()
    .messages({ 'string.pattern.base': 'Enter a valid 10-digit Ghana mobile number (e.g. 0241234567).' }),
  bankCode: Joi.string().valid('MTN', 'VOD', 'ATL').required()
    .messages({ 'any.only': 'Select a valid network: MTN, Vodafone, or AirtelTigo.' }),
}));

exports.validateSetupPayout = validate(Joi.object({
  accountNumber: Joi.string().pattern(/^0\d{9}$/).required(),
  networkCode:   Joi.string().valid('MTN', 'VOD', 'ATL').required(),
  accountName:   Joi.string().trim().min(2).max(100).required()
    .messages({ 'string.min': 'Account name must come from the verification step.' }),
}));