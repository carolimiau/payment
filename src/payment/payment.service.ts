import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebpayPlus, Options, Environment, IntegrationCommerceCodes, IntegrationApiKeys } from 'transbank-sdk';
import { WebpayTransaction } from '../entities/WebpayTransaction.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CommitTransactionDto } from './dto/commit-transaction.dto';
import { RefundTransactionDto } from './dto/refund-transaction.dto';

@Injectable()
export class PaymentService {
  private tx: any;
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectRepository(WebpayTransaction)
    private transactionRepository: Repository<WebpayTransaction>,
  ) {
    if (process.env.NODE_ENV === 'production') {
      this.tx = new WebpayPlus.Transaction(
        new Options(
          process.env.WEBPAY_COMMERCE_CODE,
          process.env.WEBPAY_API_KEY,
          Environment.Production,
        ),
      );
    } else {
      this.tx = new WebpayPlus.Transaction(
        new Options(
          IntegrationCommerceCodes.WEBPAY_PLUS,
          IntegrationApiKeys.WEBPAY,
          Environment.Integration,
        ),
      );
    }
  }

  async create(createTransactionDto: CreateTransactionDto) {
    const { amount, buyOrder, sessionId, returnUrl } = createTransactionDto;
    try {
      const response = await this.tx.create(buyOrder, sessionId, amount, returnUrl);
      
      // Save initial transaction state
      const transaction = this.transactionRepository.create({
        token: response.token,
        status: 'INITIALIZED',
        amount: amount,
        buyOrder: buyOrder,
        sessionId: sessionId,
        rawResponse: JSON.stringify(response),
      });
      await this.transactionRepository.save(transaction);

      return {
        token: response.token,
        url: response.url,
      };
    } catch (error) {
      this.logger.error('Error creating transaction', error);
      throw new InternalServerErrorException(error.message);
    }
  }

  async commit(commitTransactionDto: CommitTransactionDto) {
    const { token } = commitTransactionDto;
    try {
      const response = await this.tx.commit(token);
      
      // Update transaction state
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        transaction.status = response.status; // e.g., 'AUTHORIZED', 'FAILED'
        transaction.rawResponse = JSON.stringify(response);
        await this.transactionRepository.save(transaction);
      } else {
        // If for some reason we don't have it (maybe created before migration?), create it
        const newTransaction = this.transactionRepository.create({
          token: token,
          status: response.status,
          amount: response.amount,
          buyOrder: response.buy_order,
          sessionId: response.session_id,
          rawResponse: JSON.stringify(response),
        });
        await this.transactionRepository.save(newTransaction);
      }

      return response;
    } catch (error) {
      this.logger.error('Error committing transaction', error);
      throw new InternalServerErrorException(error.message);
    }
  }

  async status(token: string) {
    try {
      const response = await this.tx.status(token);
      
      // Update transaction state if needed
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        transaction.status = response.status;
        transaction.rawResponse = JSON.stringify(response);
        await this.transactionRepository.save(transaction);
      }

      return response;
    } catch (error) {
      this.logger.error('Error getting status', error);
      throw new InternalServerErrorException(error.message);
    }
  }

  async refund(refundTransactionDto: RefundTransactionDto) {
    const { token, amount } = refundTransactionDto;
    try {
      const response = await this.tx.refund(token, amount);
      
      // Log refund in DB? The entity structure is simple, maybe just update rawResponse or status?
      // For now, let's just update the rawResponse to include refund info or create a new record if we had a separate refunds table.
      // Since we only have one table, we might just update the status if it's a full refund, or just log it.
      // Let's update the status to 'REFUNDED' or 'PARTIALLY_REFUNDED' if applicable, but Transbank response type is what matters.
      
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        transaction.rawResponse = JSON.stringify({ ...JSON.parse(transaction.rawResponse || '{}'), refund: response });
        // transaction.status = 'REFUNDED'; // Optional: depending on business logic
        await this.transactionRepository.save(transaction);
      }

      return response;
    } catch (error) {
      this.logger.error('Error refunding', error);
      throw new InternalServerErrorException(error.message);
    }
  }
}
