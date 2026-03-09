import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PaymentModule } from './payment/payment.module';
import { WebpayTransaction } from './entities/WebpayTransaction.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: process.env.MYSQLHOST || 'localhost',
      port: parseInt(process.env.MYSQLPORT || '3306', 10),
      username: process.env.MYSQLUSER || 'root',
      password: process.env.MYSQLPASSWORD || '',
      database: process.env.MYSQLDATABASE || 'auto_box',
      entities: [WebpayTransaction],
      synchronize: false, // ¡Perfecto! Déjalo así, la tabla ya existe.
      ssl: process.env.MYSQL_SSL === 'true' || (process.env.MYSQLHOST && process.env.MYSQLHOST !== 'localhost')
        ? { rejectUnauthorized: false }
        : undefined,
    }),
    PaymentModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger(AppModule.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.ensureUpdatedAtColumn();
  }

  private async ensureUpdatedAtColumn(): Promise<void> {
    try {
      const rows = await this.dataSource.query(
        `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'webpay_plus_transaccion'
            AND COLUMN_NAME = 'updatedAt'
          LIMIT 1
        `,
      );

      if (Array.isArray(rows) && rows.length > 0) {
        return;
      }

      this.logger.warn("Columna 'updatedAt' no encontrada en webpay_plus_transaccion. Aplicando parche de compatibilidad...");

      await this.dataSource.query(
        `
          ALTER TABLE webpay_plus_transaccion
          ADD COLUMN updatedAt DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
        `,
      );

      this.logger.log("Parche aplicado: columna 'updatedAt' creada correctamente.");
    } catch (error: any) {
      if (error?.code === 'ER_DUP_FIELDNAME') {
        this.logger.log("La columna 'updatedAt' ya existía. Parche de compatibilidad omitido.");
        return;
      }

      this.logger.error(
        `No se pudo validar/parchar la columna 'updatedAt': ${error?.message || error}`,
      );
    }
  }
}
