import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, IsUrl } from 'class-validator';

export class CreateTransactionDto {
  @ApiProperty({ example: 1000, description: 'Amount to be paid' })
  @IsNumber()
  amount: number;

  @ApiProperty({ example: 'order-123', description: 'Unique buy order id' })
  @IsString()
  buyOrder: string;

  @ApiProperty({ example: 'session-123', description: 'Session id' })
  @IsString()
  sessionId: string;

  @ApiProperty({ example: 'http://localhost:3000/callback', description: 'Return URL after payment' })
  @IsUrl()
  returnUrl: string;
}
