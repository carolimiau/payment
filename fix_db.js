const mysql = require('mysql2/promise');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306', 10),
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || 'PsSRkvOapIfYDeREGwpfAIHDSkNmNHWA',
    database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'railway',
    ssl:
      process.env.MYSQL_SSL === 'true' ||
      (process.env.MYSQLHOST && process.env.MYSQLHOST !== 'localhost' && process.env.MYSQLHOST !== '127.0.0.1')
        ? { rejectUnauthorized: false }
        : undefined,
  });

  try {
    console.log('Adding updatedAt column...');
    await connection.execute('ALTER TABLE webpay_plus_transaccion ADD COLUMN updatedAt DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6);');
    console.log('Column added successfully.');
  } catch (error) {
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('Column already exists.');
    } else {
      console.error('Error adding column:', error);
    }
  } finally {
    await connection.end();
  }
}

main();
