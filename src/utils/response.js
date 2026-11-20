function success(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function error(res, message, statusCode, code, errors) {
  const body = { success: false, error: { message, code } };
  if (errors !== undefined) {
    body.error.errors = errors;
  }
  return res.status(statusCode).json(body);
}

export { success, error };
