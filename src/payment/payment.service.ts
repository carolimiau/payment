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
    // 1. Definimos el entorno: Si tu variable dice 'production', usa PROD. 
    // Si dice 'TEST' o no existe, usa INTEGRACIÓN.
    const environment = process.env.WEBPAY_ENV === 'TEST' 
      ? Environment.Production 
      : Environment.Integration;

    // 2. Cargamos las llaves. 
    // Si no están en las variables de entorno (por error), usamos las de prueba por defecto para que no falle.
    const commerceCode = process.env.WEBPAY_COMMERCE_CODE || IntegrationCommerceCodes.WEBPAY_PLUS;
    const apiKey = process.env.WEBPAY_API_KEY || IntegrationApiKeys.WEBPAY;

    this.logger.log(`🔌 Initializing Webpay Plus in mode: ${process.env.WEBPAY_ENV || 'INTEGRATION (Default)'}`);

    // 3. Instanciamos Transbank una sola vez
    this.tx = new WebpayPlus.Transaction(
      new Options(commerceCode, apiKey, environment)
    );
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
      // Verificar si ya fue procesada (Idempotencia)
      const existingTransaction = await this.transactionRepository.findOne({ where: { token } });
      
      let response: any;
      let alreadyProcessed = false;
      
      // Si ya está autorizada en base de datos, no llamamos a Transbank de nuevo
      if (existingTransaction && (existingTransaction.status === 'AUTHORIZED' || existingTransaction.rawResponse?.includes('authorization_code'))) {
        this.logger.log(`⚠️ Transaction already processed locally, using cached data: ${token.substring(0, 10)}...`);
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
          
          // Manejo especial error 422 (Doble commit / Race Condition)
          if (error?.message?.includes('422') || 
              error?.message?.includes('already locked') ||
              error?.message?.includes('Invalid status')) {
            
            this.logger.warn(`⚠️ Error 422 detected. Transaction might be processed by another thread. Checking DB...`);
            
            // Reintentar leer de la DB (Pequeño delay para dar tiempo al otro proceso de escribir)
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, 500)); // Esperar 500ms
              }
              
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
              this.logger.warn(`Transaction not found in DB after retries.`);
              // Devolvemos un estado "en proceso" para que el frontend no muestre error fatal
              return { 
                status: 'PROCESSING', 
                message: 'Transaction is being processed',
                error: 'already_processing'
              };
            }
          } else {
            // Si es otro error (ej: tarjeta rechazada o error de red), lo lanzamos.
            throw error;
          }
        }
      }
      
      // Guardar en DB solo si obtuvimos respuesta nueva de Transbank
      if (!alreadyProcessed && response) {
        const transaction = existingTransaction || this.transactionRepository.create({
          token: token,
          buyOrder: response.buy_order,
          sessionId: response.session_id,
        });
        
        transaction.status = response.status;
        transaction.amount = response.amount; // Asegurar guardar monto confirmado
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
      
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        // Anexamos la info del refund al JSON existente sin borrar lo anterior
        const currentData = transaction.rawResponse ? JSON.parse(transaction.rawResponse) : {};
        transaction.rawResponse = JSON.stringify({ ...currentData, refund: response });
        
        // Opcional: Si el refund es total, podrías cambiar el estado
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