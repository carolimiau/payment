const mysql = require('mysql2/promise');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQLHOST,
    port: parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306', 10),
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    ssl: process.env.MYSQLHOST ? { rejectUnauthorized: false } : undefined,
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
