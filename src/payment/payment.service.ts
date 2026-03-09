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
  private readonly commitPollAttempts = 45;
  private readonly commitPollDelayMs = 1000;

  private maskToken(token?: string): string {
    if (!token) {
      return '(empty)';
    }
    if (token.length <= 10) {
      return `${token.substring(0, 4)}...`;
    }
    return `${token.substring(0, 10)}...`;
  }

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

    return status === 'AUTHORIZED' && (responseCode === 0 || responseCode === null);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async saveTransactionSnapshot(token: string, status: string, payload: any) {
    this.logger.debug(`🧾 saveTransactionSnapshot | token=${this.maskToken(token)} | status=${status}`);
    try {
      const transaction = await this.transactionRepository.findOne({ where: { token } });
      if (transaction) {
        transaction.status = status;
        transaction.rawResponse = JSON.stringify(payload);
        await this.transactionRepository.save(transaction);
        this.logger.debug(`🧾 Snapshot persistido | token=${this.maskToken(token)} | status=${status}`);
      } else {
        this.logger.warn(`🧾 Snapshot sin registro local | token=${this.maskToken(token)} | status=${status}`);
      }
    } catch (error) {
      this.logger.warn(`No se pudo persistir snapshot de transacción ${token.substring(0, 10)}...: ${error.message}`);
    }
  }

  private async waitForAuthorization(token: string) {
    let lastStatusResponse: any = null;
    let lastTransientErrorDetail = '';

    this.logger.warn(`⏳ Commit en estado transitorio. Iniciando polling de status para token ${token.substring(0, 10)}...`);

    for (let attempt = 1; attempt <= this.commitPollAttempts; attempt++) {
      // 1) Reintentar commit (en estados 10/19/20 suele terminar autorizando unos segundos después)
      try {
        const commitResponse = await this.tx.commit(token);
        const parsedCommitResponseCode = this.parseResponseCode(commitResponse?.response_code);
        this.logger.log(
          `✅ Reintento commit exitoso ${attempt}/${this.commitPollAttempts} | status=${commitResponse?.status} | response_code=${parsedCommitResponseCode}`,
        );

        await this.saveTransactionSnapshot(token, commitResponse?.status || 'AUTHORIZED', commitResponse);
        return commitResponse;
      } catch (commitRetryError) {
        const commitRetryErrorDetail = this.formatSdkError(commitRetryError);
        lastTransientErrorDetail = commitRetryErrorDetail;

        if (this.isAlreadyProcessedCommitError(commitRetryError)) {
          this.logger.warn(
            `⚠️ Reintento commit transitorio ${attempt}/${this.commitPollAttempts}: ${commitRetryErrorDetail}`,
          );
        } else {
          this.logger.error(`❌ Reintento commit falló con error no transitorio: ${commitRetryErrorDetail}`);
          throw commitRetryError;
        }
      }

      // 2) Consultar status por si Transbank ya dejó autorizada la transacción
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

    if (lastTransientErrorDetail) {
      this.logger.error(`❌ Finalizó polling sin autorización. Último error transitorio: ${lastTransientErrorDetail}`);
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
    this.logger.log(`🔧 Configuración base | TBK_ENV=${envVar || '(auto)'} | hasCredentials=${hasConfiguredCredentials}`);

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
      this.logger.log('🔧 Transbank PRODUCTION inicializado con credenciales configuradas');
    } else {
      // MODO INTEGRACIÓN
      commerceCode = IntegrationCommerceCodes.WEBPAY_PLUS;
      // ✅ CORRECCIÓN: Usamos la constante correcta
      apiKey = IntegrationApiKeys.WEBPAY; 
      environment = Environment.Integration;
      this.logger.log('🔧 Transbank INTEGRATION inicializado con credenciales oficiales de prueba');
    }

    // Inicializamos la transacción
    this.tx = new WebpayPlus.Transaction(new Options(commerceCode, apiKey, environment));
  }

  async create(createTransactionDto: CreateTransactionDto) {
    const { amount, returnUrl } = createTransactionDto;
    const configuredReturnUrl = this.getConfiguredReturnUrl();
    const callbackUrl = configuredReturnUrl || returnUrl;
    const normalizedAmount = Math.round(amount);

    this.logger.log(
      `🟦 [create] entrada | amount=${amount} normalizedAmount=${normalizedAmount} buyOrder=${createTransactionDto?.buyOrder || '(auto)'} sessionId=${createTransactionDto?.sessionId || '(auto)'}`,
    );
    this.logger.debug(`🟦 [create] callbackUrl seleccionado=${callbackUrl}`);

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
    this.logger.log(`🟦 [create] buyOrder final=${buyOrder} | sessionId final=${sessionId}`);

    let response: any;
    try {
      response = await this.tx.create(buyOrder, sessionId, normalizedAmount, callbackUrl);
      this.logger.log(`🟦 [create] tx.create OK | token=${this.maskToken(response?.token)} | url=${response?.url}`);
    } catch (error) {
      const errorDetail = this.formatSdkError(error);
      this.logger.error(`Error creando transacción en Transbank: ${errorDetail}`);
      throw new InternalServerErrorException(`TBK Create Error: ${errorDetail}`);
    }

    try {
      const transaction = this.transactionRepository.create({
        token: response.token,
        status: 'INITIALIZED',
        amount: normalizedAmount,
        buyOrder: buyOrder,
        sessionId: sessionId,
        rawResponse: JSON.stringify(response),
      });

      await this.transactionRepository.save(transaction);
      this.logger.log(`🟦 [create] transacción guardada localmente | token=${this.maskToken(response?.token)} status=INITIALIZED`);
    } catch (error: any) {
      this.logger.error(`Error guardando transacción local: ${error?.message || error}`);
      throw new InternalServerErrorException('Local transaction persistence error');
    }

    return {
      token: response.token,
      url: response.url,
      buyOrder,
      sessionId,
    };
  }

  async commit(commitTransactionDto: CommitTransactionDto) {
    const { token } = commitTransactionDto;
    if (!token) {
      throw new BadRequestException('Token is required to commit transaction');
    }

    this.logger.log(`Committing Transaction Token: ${token.substring(0, 10)}...`);
    this.logger.log(`🟨 [commit] inicio | token=${this.maskToken(token)}`);

    try {
      const response = await this.tx.commit(token);

      await this.saveTransactionSnapshot(token, response.status, response);

      const parsedResponseCode = this.parseResponseCode(response?.response_code);
      this.logger.log(`📌 Commit response | status=${response?.status} | response_code=${parsedResponseCode}`);
      this.logger.debug(`🟨 [commit] payload=${JSON.stringify(response)}`);

      return response;
    } catch (error) {
      const errorDetail = this.formatSdkError(error);
      this.logger.error(`Error confirmando (Commit): ${errorDetail}`);
      this.logger.warn(`🟨 [commit] error capturado | token=${this.maskToken(token)} | evaluando si es transitorio`);

      if (this.isAlreadyProcessedCommitError(error)) {
        this.logger.warn(`🟨 [commit] error transitorio detectado | token=${this.maskToken(token)} | iniciando waitForAuthorization`);
        const statusResponse = await this.waitForAuthorization(token);
        if (statusResponse) {
          this.logger.log(`🟨 [commit] waitForAuthorization devolvió respuesta | status=${statusResponse?.status} | response_code=${this.parseResponseCode(statusResponse?.response_code)}`);
          return statusResponse;
        }
      }

      await this.saveTransactionSnapshot(token, 'ERROR_COMMIT', { commitError: errorDetail });
      this.logger.error(`🟨 [commit] finaliza con ERROR_COMMIT | token=${this.maskToken(token)}`);
      throw new InternalServerErrorException(`TBK Commit Error: ${errorDetail}`);
    }
  }

  async markAsAborted(token?: string, buyOrder?: string, sessionId?: string) {
    if (!token && !buyOrder && !sessionId) {
      this.logger.warn('🟥 [markAsAborted] llamado sin identificadores');
      return;
    }

    this.logger.log(
      `🟥 [markAsAborted] inicio | token=${this.maskToken(token)} | buyOrder=${buyOrder || '(none)'} | sessionId=${sessionId || '(none)'}`,
    );

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
        this.logger.log(`🟥 [markAsAborted] transacción marcada ABORTED | token=${this.maskToken(transaction.token)}`);
      } else {
        this.logger.warn('🟥 [markAsAborted] no se encontró transacción para marcar ABORTED');
      }
    } catch (error) {
      this.logger.warn(`No se pudo marcar transacción como ABORTED: ${error.message}`);
    }
  }

  async status(token: string) {
    this.logger.log(`🟪 [status] consultando token=${this.maskToken(token)}`);
    try {
      const response = await this.tx.status(token);
      this.logger.log(`🟪 [status] OK | status=${response?.status} | response_code=${this.parseResponseCode(response?.response_code)}`);
      this.logger.debug(`🟪 [status] payload=${JSON.stringify(response)}`);
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
    this.logger.log(`🟧 [refund] inicio | token=${this.maskToken(token)} | amount=${amount} | normalized=${Math.round(amount)}`);

    try {
      const response = await this.tx.refund(token, Math.round(amount));
      this.logger.log(`🟧 [refund] tx.refund OK | type=${response?.type} | balance=${response?.balance}`);
      
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
        this.logger.log(`🟧 [refund] transacción local actualizada | token=${this.maskToken(token)} | status=${transaction.status}`);
      }
      return response;
    } catch (error) {
      const errorDetail = this.formatSdkError(error);
      this.logger.error(`Error en reembolso: ${errorDetail}`);
      throw new InternalServerErrorException(`TBK Refund Error: ${errorDetail}`);
    }
  }
}