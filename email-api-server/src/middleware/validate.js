function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validateBody };
