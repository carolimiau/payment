import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
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
  private readonly commitPollAttempts = 12;
  private readonly commitPollDelayMs = 1000;

  private getConfiguredEnvironment(): string {
    return (process.env.TBK_ENV || '').trim().toUpperCase();
  }

  private getConfiguredCommerceCode(): string {
    return (
      process.env.TBK_COMMERCE_CODE ||
      ''
    ).trim();
  }

  private getConfiguredApiKey(): string {
    return (
      process.env.TBK_API_KEY_SECRET ||
      ''
    ).trim();
  }

  private getConfiguredReturnUrl(): string {
    return (process.env.TBK_RETURN_URL || '').trim();
  }

  private isUsingIntegrationCredentials(commerceCode: string, apiKey: string): boolean {
    return (
      commerceCode === IntegrationCommerceCodes.WEBPAY_PLUS ||
      apiKey === IntegrationApiKeys.WEBPAY
    );
  }

  private formatSdkError(error: any): string {
    const responseData = error?.response?.data;
    if (typeof responseData === 'string') {
      return responseData;
    }
    if (responseData) {
      return JSON.stringify(responseData);
    }
    return error?.message || 'Unknown Transbank error';
  }

  private parseResponseCode(value: any): number | null {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return null;
  }

  private isAuthorizedResponse(response: any): boolean {
    const responseCode = this.parseResponseCode(response?.response_code);
    const status = String(response?.status || '').toUpperCase();

    return status === 'AUTHORIZED' && responseCode === 0;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async saveTransactionSnapshot(token: string, status: string, payload: any) {
    try {
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        transaction.status = status;
        transaction.rawResponse = JSON.stringify(payload);
        await this.transactionRepository.save(transaction);
      }
    } catch (error) {
      this.logger.warn(`No se pudo persistir snapshot de transacción ${token.substring(0, 10)}...: ${error.message}`);
    }
  }

  private async waitForAuthorization(token: string) {
    let lastStatusResponse: any = null;

    this.logger.warn(`⏳ Commit en estado transitorio. Iniciando polling de status para token ${token.substring(0, 10)}...`);

    for (let attempt = 1; attempt <= this.commitPollAttempts; attempt++) {
      try {
        const statusResponse = await this.tx.status(token);
        lastStatusResponse = statusResponse;

        const parsedResponseCode = this.parseResponseCode(statusResponse?.response_code);
        this.logger.log(
          `🔎 Poll status intento ${attempt}/${this.commitPollAttempts} | status=${statusResponse?.status} | response_code=${parsedResponseCode}`,
        );

        if (this.isAuthorizedResponse(statusResponse)) {
          this.logger.log('✅ Transacción autorizada durante polling de status');
          await this.saveTransactionSnapshot(token, statusResponse.status, statusResponse);
          return statusResponse;
        }
      } catch (statusError) {
        const statusErrorDetail = this.formatSdkError(statusError);
        this.logger.warn(`⚠️ Error consultando status en polling (intento ${attempt}): ${statusErrorDetail}`);
      }

      await this.sleep(this.commitPollDelayMs);
    }

    if (lastStatusResponse) {
      await this.saveTransactionSnapshot(token, lastStatusResponse?.status || 'PENDING', lastStatusResponse);
    }

    return lastStatusResponse;
  }

  private isAlreadyProcessedCommitError(error: any): boolean {
    const rawMessage = this.formatSdkError(error).toLowerCase();
    const httpStatus = error?.response?.status;

    return (
      httpStatus === 422 ||
      rawMessage.includes("invalid status '19'") ||
      rawMessage.includes("invalid status '20'") ||
      rawMessage.includes('while authorizing') ||
      rawMessage.includes('already') ||
      rawMessage.includes('committed') ||
      rawMessage.includes('ha sido') ||
      rawMessage.includes('ya fue')
    );
  }

  constructor(
    @InjectRepository(WebpayTransaction)
    private transactionRepository: Repository<WebpayTransaction>,
  ) {
    const envVar = this.getConfiguredEnvironment();

    const configuredCommerceCode = this.getConfiguredCommerceCode();
    const configuredApiKey = this.getConfiguredApiKey();
    const hasConfiguredCredentials = !!configuredCommerceCode && !!configuredApiKey;
    const credentialsAreIntegration = this.isUsingIntegrationCredentials(configuredCommerceCode, configuredApiKey);

    if (envVar === 'PRODUCTION' || envVar === 'PROD') {
      this.isProduction = true;
    } else if (envVar === 'INTEGRATION' || envVar === 'TEST') {
      this.isProduction = false;
    } else {
      this.isProduction = hasConfiguredCredentials && !credentialsAreIntegration;
    }

    if (this.isProduction && credentialsAreIntegration) {
      this.logger.warn(
        '⚠️ Configuración inconsistente detectada: TBK_ENV=PRODUCTION con credenciales de integración. Se forzará modo INTEGRATION para evitar caída del servicio.',
      );
      this.isProduction = false;
    }

    if (!this.isProduction && envVar === 'INTEGRATION' && hasConfiguredCredentials && !credentialsAreIntegration) {
      this.logger.warn('⚠️ TBK_ENV=INTEGRATION pero se detectaron credenciales de producción. Se mantendrá modo INTEGRATION por configuración explícita.');
    }

    this.logger.log(`🔧 Inicializando Transbank en modo: ${this.isProduction ? '🔴 PRODUCCIÓN' : '🟢 INTEGRACIÓN (TEST)'}`);

    let commerceCode: string;
    let apiKey: string;
    let environment: Environment;

    if (this.isProduction) {
      // MODO PRODUCCIÓN
      commerceCode = configuredCommerceCode;
      apiKey = configuredApiKey;
      environment = Environment.Production;

      if (!commerceCode || !apiKey) {
        throw new Error('Faltan credenciales de Transbank para PRODUCCIÓN (TBK_COMMERCE_CODE / TBK_API_KEY_SECRET).');
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
    const configuredReturnUrl = this.getConfiguredReturnUrl();
    const callbackUrl = configuredReturnUrl || returnUrl;
    const normalizedAmount = Math.round(amount);

    if (!Number.isInteger(normalizedAmount) || normalizedAmount <= 0) {
      throw new BadRequestException('Amount must be a positive integer');
    }

    if (!callbackUrl) {
      throw new BadRequestException('Return URL is required');
    }

    if (this.isProduction) {
      let parsedReturnUrl: URL;
      try {
        parsedReturnUrl = new URL(callbackUrl);
      } catch {
        throw new BadRequestException('Invalid return URL format for production');
      }

      if (parsedReturnUrl.protocol !== 'https:') {
        throw new BadRequestException('Return URL must use HTTPS in production');
      }

      if (parsedReturnUrl.hostname === 'localhost' || parsedReturnUrl.hostname === '127.0.0.1') {
        throw new BadRequestException('Return URL must be publicly reachable in production');
      }
    }
    
    // Limitar largo de strings para evitar rechazo de TBK
    const buyOrder = (createTransactionDto.buyOrder || `order-${Date.now()}`).substring(0, 26);
    const sessionId = (createTransactionDto.sessionId || `session-${Date.now()}`).substring(0, 50);

    this.logger.log(`Initiating Transaction | Order: ${buyOrder} | Amount: ${normalizedAmount}`);

    try {
      const response = await this.tx.create(buyOrder, sessionId, normalizedAmount, callbackUrl);

      const transaction = this.transactionRepository.create({
        token: response.token,
        status: 'INITIALIZED',
        amount: normalizedAmount,
        buyOrder: buyOrder,
        sessionId: sessionId,
        rawResponse: JSON.stringify(response),
      });

      await this.transactionRepository.save(transaction);
      
      return {
        token: response.token,
        url: response.url,
        buyOrder,
        sessionId,
      };
    } catch (error) {
      const errorDetail = this.formatSdkError(error);
      this.logger.error(`Error creando transacción: ${errorDetail}`);
      throw new InternalServerErrorException(`TBK Create Error: ${errorDetail}`);
    }
  }

  async commit(commitTransactionDto: CommitTransactionDto) {
    const { token } = commitTransactionDto;
    if (!token) {
      throw new BadRequestException('Token is required to commit transaction');
    }

    this.logger.log(`Committing Transaction Token: ${token.substring(0, 10)}...`);

    try {
      const response = await this.tx.commit(token);

      await this.saveTransactionSnapshot(token, response.status, response);

      const parsedResponseCode = this.parseResponseCode(response?.response_code);
      this.logger.log(`📌 Commit response | status=${response?.status} | response_code=${parsedResponseCode}`);

      return response;
    } catch (error) {
      const errorDetail = this.formatSdkError(error);
      this.logger.error(`Error confirmando (Commit): ${errorDetail}`);

      if (this.isAlreadyProcessedCommitError(error)) {
        const statusResponse = await this.waitForAuthorization(token);
        if (statusResponse) {
          return statusResponse;
        }
      }

      await this.saveTransactionSnapshot(token, 'ERROR_COMMIT', { commitError: errorDetail });
      throw new InternalServerErrorException(`TBK Commit Error: ${errorDetail}`);
    }
  }

  async markAsAborted(token?: string, buyOrder?: string, sessionId?: string) {
    if (!token && !buyOrder && !sessionId) {
      return;
    }

    try {
      let transaction: WebpayTransaction | null = null;

      if (token) {
        transaction = await this.transactionRepository.findOne({ where: { token } });
      }

      if (!transaction && buyOrder && sessionId) {
        transaction = await this.transactionRepository.findOne({
          where: { buyOrder, sessionId },
          order: { createdAt: 'DESC' },
        });
      } else if (!transaction && buyOrder) {
        transaction = await this.transactionRepository.findOne({
          where: { buyOrder },
          order: { createdAt: 'DESC' },
        });
      }

      if (transaction) {
        transaction.status = 'ABORTED';

        const currentData = transaction.rawResponse ? JSON.parse(transaction.rawResponse) : {};
        transaction.rawResponse = JSON.stringify({
          ...currentData,
          aborted: {
            at: new Date().toISOString(),
            token: token || null,
            buyOrder: buyOrder || null,
            sessionId: sessionId || null,
          },
        });

        await this.transactionRepository.save(transaction);
      }
    } catch (error) {
      this.logger.warn(`No se pudo marcar transacción como ABORTED: ${error.message}`);
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
      const errorDetail = this.formatSdkError(error);
      this.logger.error(`Error en reembolso: ${errorDetail}`);
      throw new InternalServerErrorException(`TBK Refund Error: ${errorDetail}`);
    }
  }
}