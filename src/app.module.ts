import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
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
export class AppModule {}
