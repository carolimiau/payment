import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUrl, MaxLength, Min } from 'class-validator';

export class CreateTransactionDto {
  @ApiProperty({ example: 1000, description: 'Amount to be paid' })
  @IsInt()
  @Min(1)
  amount: number;

  @ApiProperty({ example: 'order-123', description: 'Unique buy order id', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(26)
  buyOrder?: string;

  @ApiProperty({ example: 'session-123', description: 'Session id', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sessionId?: string;

  @ApiProperty({ example: 'http://localhost:3000/callback', description: 'Return URL after payment' })
  @IsUrl()
  returnUrl: string;
}
