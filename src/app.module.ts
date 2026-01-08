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
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 3306,
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'rayen123%',
      database: process.env.DB_NAME || 'auto_box',
      entities: [WebpayTransaction],
      synchronize: false, // We rely on the main backend or migrations for schema sync
    }),
    PaymentModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
