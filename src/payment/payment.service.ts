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
    // CORRECCIÓN 1: Lógica segura. 
    // Por defecto es INTEGRACIÓN. Solo si dice 'PRODUCTION' explícitamente, pasa a real.
    const isProduction = process.env.TBK_ENV === 'PRODUCTION';
    
    const environment = isProduction 
      ? Environment.Production 
      : Environment.Integration;

    // Cargamos llaves (Tu código usa WEBPAY_..., así que mantendremos eso)
    const commerceCode = process.env.TBK_COMMERCE_CODE || IntegrationCommerceCodes.WEBPAY_PLUS;
    const apiKey = process.env.TBK_API_KEY_SECRET|| IntegrationApiKeys.WEBPAY;

    this.logger.log(`🔌 Initializing Webpay Plus in mode: ${isProduction ? '🚨 PRODUCTION (REAL MONEY) 🚨' : '🧪 INTEGRATION (TEST)'}`);

    this.tx = new WebpayPlus.Transaction(
      new Options(commerceCode, apiKey, environment)
    );
  }

  async create(createTransactionDto: CreateTransactionDto) {
    const { amount, buyOrder, sessionId, returnUrl } = createTransactionDto;
    
    // CORRECCIÓN 2: Limpieza de Monto. Transbank falla si recibe decimales en CLP.
    const cleanAmount = Math.round(amount);

    try {
      const response = await this.tx.create(buyOrder, sessionId, cleanAmount, returnUrl);
      
      const transaction = this.transactionRepository.create({
        token: response.token,
        status: 'INITIALIZED',
        amount: cleanAmount,
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
      // Verificar si ya fue procesada (Idempotencia)
      const existingTransaction = await this.transactionRepository.findOne({ where: { token } });
      
      let response: any;
      let alreadyProcessed = false;
      
      // Si ya está autorizada en DB local, devolvemos lo guardado
      if (existingTransaction && (existingTransaction.status === 'AUTHORIZED' || existingTransaction.rawResponse?.includes('authorization_code'))) {
        this.logger.log(`⚠️ Transaction already processed locally: ${token.substring(0, 10)}...`);
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
          this.logger.error(`❌ Transbank commit failed:`, error.message);
          
          // Manejo especial error 422 (Race Condition / Doble Confirmación)
          // Esto ocurre si el usuario o el navegador reenvían la petición muy rápido
          if (error?.message?.includes('422') || 
              error?.message?.includes('already locked') ||
              error?.message?.includes('Invalid status')) {
            
            this.logger.warn(`⚠️ Error 422 detected (Possible Race Condition). Checking DB...`);
            
            // Reintentar leer de la DB (Pequeño delay para dar tiempo al otro proceso)
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 800)); // Delay aumentado a 800ms
              
              const reloaded = await this.transactionRepository.findOne({ where: { token } });
              if (reloaded && (reloaded.status === 'AUTHORIZED' || reloaded.rawResponse?.includes('authorization_code'))) {
                alreadyProcessed = true;
                try {
                  response = JSON.parse(reloaded.rawResponse);
                } catch (e) {
                  response = { status: reloaded.status, amount: reloaded.amount };
                }
                this.logger.log(`✅ Found transaction in DB after retry ${attempt + 1}`);
                break;
              }
            }
            
            if (!alreadyProcessed) {
              // Si falla todo, devolvemos PROCESSING para que el cliente reintente suavemente o espere
              return { status: 'PROCESSING', message: 'Transaction under process', error: 'already_processing' };
            }
          } else {
            throw error;
          }
        }
      }
      
      // Guardar en DB solo si obtuvimos respuesta fresca de TBK
      if (!alreadyProcessed && response) {
        const transaction = existingTransaction || this.transactionRepository.create({
          token: token,
          buyOrder: response.buy_order,
          sessionId: response.session_id,
        });
        
        transaction.status = response.status;
        transaction.amount = response.amount;
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
      // Actualizamos estado si consultamos
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
      const response = await this.tx.refund(token, Math.round(amount)); // Round también aquí por seguridad
      
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        const currentData = transaction.rawResponse ? JSON.parse(transaction.rawResponse) : {};
        transaction.rawResponse = JSON.stringify({ ...currentData, refund: response });
        
        if (response.type === 'NULLIFY' || response.balance === 0) {
           transaction.status = 'REFUNDED';
        }
        await this.transactionRepository.save(transaction);
      }
      return response;
    } catch (error) {
      this.logger.error('Error refunding', error);
      throw new InternalServerErrorException(error.message);
    }
  }
}