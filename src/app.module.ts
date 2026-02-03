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
      host: process.env.MYSQLHOST, 
      port: parseInt(process.env.MYSQLPORT, 10), 
      username: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      entities: [WebpayTransaction],
      synchronize: false, // ¡Perfecto! Déjalo así, la tabla ya existe.
      ssl: {
        rejectUnauthorized: false, // <--- La pieza clave 🔑
      },
    }),
    PaymentModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
