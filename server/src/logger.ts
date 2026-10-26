import pino from 'pino';

/** Field paths removed from logs. Values are replaced; keys stay so operators can see the shape. */
export const redactPaths = [
  'password',
  'secret',
  'sessionSecret',
  'recoveryPassword',
  'cookie',
  'cookies',
  'authorization',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["set-cookie"]',
  'req.headers["x-recovery-password"]',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.sessionSecret',
  '*.recoveryPassword',
  '*.cookie',
  '*.cookies',
  '*.authorization',
  '*.*.password',
  '*.*.secret',
  '*.*.sessionSecret',
  '*.*.recoveryPassword',
  '*.*.cookie',
  '*.*.cookies',
  '*.*.authorization',
  '*.headers.cookie',
  '*.headers.authorization',
  '*.headers["set-cookie"]',
];

export const redactOptions = {
  paths: redactPaths,
  censor: '[Redacted]',
};

export function createLogger(destination?: pino.DestinationStream) {
  return pino({ level: 'info', redact: redactOptions }, destination);
}
