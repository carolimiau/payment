import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { 
  WebpayPlus, 
  Options, 
  Environment, 
  IntegrationCommerceCodes, 
  IntegrationApiKeys 
} from 'transbank-sdk';
import { WebpayTransaction } from '../entities/WebpayTransaction.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CommitTransactionDto } from './dto/commit-transaction.dto';
import { RefundTransactionDto } from './dto/refund-transaction.dto';

@Injectable()
export class PaymentService {
  private tx: any;
  private readonly logger = new Logger(PaymentService.name);
  private isProduction: boolean;

  constructor(
    @InjectRepository(WebpayTransaction)
    private transactionRepository: Repository<WebpayTransaction>,
  ) {
    // 1. Detección de entorno ROBUSTA (Insensible a mayúsculas y espacios)
    const envVar = (process.env.TBK_ENV || '').trim().toUpperCase();
    this.isProduction = envVar === 'PRODUCTION' || envVar === 'PROD';

    this.logger.log(`🔧 Inicializando Transbank en modo: ${this.isProduction ? '🔴 PRODUCCIÓN' : '🟢 INTEGRACIÓN (TEST)'}`);

    let commerceCode: string;
    let apiKey: string;
    let environment: Environment;

    if (this.isProduction) {
      // MODO PRODUCCIÓN
      commerceCode = (process.env.TBK_COMMERCE_CODE || '').trim();
      apiKey = (process.env.TBK_API_KEY_SECRET || '').trim();
      environment = Environment.Production;

      if (!commerceCode || !apiKey) {
        this.logger.error('❌ ERROR CRÍTICO: Faltan credenciales de Transbank para Producción en el .env');
      }
    } else {
      // MODO INTEGRACIÓN
      commerceCode = IntegrationCommerceCodes.WEBPAY_PLUS;
      // ✅ CORRECCIÓN: Usamos la constante correcta
      apiKey = IntegrationApiKeys.WEBPAY; 
      environment = Environment.Integration;
    }

    // Inicializamos la transacción
    this.tx = new WebpayPlus.Transaction(new Options(commerceCode, apiKey, environment));
  }

  async create(createTransactionDto: CreateTransactionDto) {
    const { amount, returnUrl } = createTransactionDto;
    
    // Limitar largo de strings para evitar rechazo de TBK
    const buyOrder = (createTransactionDto.buyOrder || `order-${Date.now()}`).substring(0, 26);
    const sessionId = (createTransactionDto.sessionId || `session-${Date.now()}`).substring(0, 61);

    this.logger.log(`Initiating Transaction | Order: ${buyOrder} | Amount: ${amount}`);

    try {
      const response = await this.tx.create(buyOrder, sessionId, amount, returnUrl);

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
        buyOrder, 
      };
    } catch (error) {
      this.logger.error(`Error creando transacción: ${error.message}`);
      throw new InternalServerErrorException(`TBK Create Error: ${error.message}`);
    }
  }

  async commit(commitTransactionDto: CommitTransactionDto) {
    const { token } = commitTransactionDto;
    this.logger.log(`Committing Transaction Token: ${token.substring(0, 10)}...`);

    try {
      const response = await this.tx.commit(token);
      
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        transaction.status = response.status;
        transaction.rawResponse = JSON.stringify(response);
        await this.transactionRepository.save(transaction);
      }
      return response;
    } catch (error) {
      this.logger.error(`Error confirmando (Commit): ${error.message}`);
      // Actualizamos estado a error si existe
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        transaction.status = 'ERROR_COMMIT';
        await this.transactionRepository.save(transaction);
      }
      throw new InternalServerErrorException(`TBK Commit Error: ${error.message}`);
    }
  }

  async status(token: string) {
    try {
      const response = await this.tx.status(token);
      return response;
    } catch (error) {
      this.logger.error('Error getting status', error);
      throw new InternalServerErrorException(error.message);
    }
  }

  // ✅ RESTAURADO: Método de reembolso
  async refund(refundTransactionDto: RefundTransactionDto) {
    const { token, amount } = refundTransactionDto;
    this.logger.log(`Refunding Transaction Token: ${token.substring(0, 10)}... Amount: ${amount}`);

    try {
      const response = await this.tx.refund(token, Math.round(amount));
      
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        // Guardamos el historial del refund en el rawResponse
        const currentData = transaction.rawResponse ? JSON.parse(transaction.rawResponse) : {};
        transaction.rawResponse = JSON.stringify({ ...currentData, refund: response });
        
        // Si el reembolso es total o anulación
        if (response.type === 'NULLIFY' || response.balance === 0) {
           transaction.status = 'REFUNDED';
        } else {
           transaction.status = 'PARTIALLY_REFUNDED';
        }
        
        await this.transactionRepository.save(transaction);
      }
      return response;
    } catch (error) {
      this.logger.error(`Error en reembolso: ${error.message}`);
      throw new InternalServerErrorException(`TBK Refund Error: ${error.message}`);
    }
  }
}