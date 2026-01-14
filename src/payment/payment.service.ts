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
      // Verificar si ya fue procesada
      const existingTransaction = await this.transactionRepository.findOne({ where: { token } });
      
      let response: any;
      let alreadyProcessed = false;
      
      // Si ya está autorizada, retornar datos almacenados
      if (existingTransaction && (existingTransaction.status === 'AUTHORIZED' || existingTransaction.rawResponse?.includes('authorization_code'))) {
        this.logger.log(`⚠️ Transaction already processed, using cached data: ${token.substring(0, 10)}...`);
        alreadyProcessed = true;
        
        try {
          response = JSON.parse(existingTransaction.rawResponse);
        } catch (e) {
          response = { status: existingTransaction.status, amount: existingTransaction.amount };
        }
      } else {
        // Intentar confirmar con Transbank
        try {
          this.logger.log(`🔄 Calling Transbank commit for token: ${token.substring(0, 10)}...`);
          response = await this.tx.commit(token);
          this.logger.log(`✅ Transbank commit success:`, JSON.stringify(response));
        } catch (error: any) {
          this.logger.error(`❌ Transbank commit failed:`, error.message, error.stack);
          // Error 422: Transacción ya procesada por otro proceso
          if (error?.message?.includes('422') || 
              error?.message?.includes('already locked') ||
              error?.message?.includes('Invalid status')) {
            this.logger.warn(`⚠️ Error 422: Transaction already processed, checking database: ${token.substring(0, 10)}...`);
            
            // Reintentar leer de la DB con espera (otro proceso podría estar guardando)
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, 500)); // Esperar 500ms
                this.logger.log(`Retry ${attempt}/3: Checking database again...`);
              }
              
              const reloaded = await this.transactionRepository.findOne({ where: { token } });
              if (reloaded && (reloaded.status === 'AUTHORIZED' || reloaded.rawResponse?.includes('authorization_code'))) {
                alreadyProcessed = true;
                try {
                  response = JSON.parse(reloaded.rawResponse);
                } catch (e) {
                  response = { status: reloaded.status, amount: reloaded.amount };
                }
                this.logger.log(`✅ Found transaction in DB after retry ${attempt}`);
                break;
              }
            }
            
            // Si después de reintentos no tenemos confirmación, retornar error genérico sin lanzar
            if (!alreadyProcessed) {
              this.logger.warn(`Transaction ${token.substring(0, 10)} not found in DB after retries, returning generic error`);
              response = { 
                status: 'PROCESSING', 
                message: 'Transaction is being processed by another request',
                error: 'already_processing'
              };
            }
          } else {
            throw error;
          }
        }
      }
      
      // Update transaction state only if not already processed
      if (!alreadyProcessed) {
        const transaction = existingTransaction || this.transactionRepository.create({
          token: token,
          status: response.status,
          amount: response.amount,
          buyOrder: response.buy_order,
          sessionId: response.session_id,
          rawResponse: JSON.stringify(response),
        });
        
        transaction.status = response.status;
        transaction.rawResponse = JSON.stringify(response);
        await this.transactionRepository.save(transaction);
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
