import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { WebpayTransaction } from '../entities/WebpayTransaction.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WebpayTransaction])],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
