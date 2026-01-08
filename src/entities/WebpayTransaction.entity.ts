import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('webpay_plus_transaccion')
export class WebpayTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  token: string;

  @Column({ length: 50 })
  status: string;

  @Column('int')
  amount: number;

  @Column({ length: 50 })
  buyOrder: string;

  @Column({ length: 50 })
  sessionId: string;

  @Column({ type: 'text', nullable: true })
  rawResponse: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
