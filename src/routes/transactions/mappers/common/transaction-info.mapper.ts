import { Inject, Injectable } from '@nestjs/common';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { ModuleTransaction } from '@/domain/safe/entities/module-transaction.entity';
import { MultisigTransaction } from '@/domain/safe/entities/multisig-transaction.entity';
import { Operation } from '@/domain/safe/entities/operation.entity';
import { TokenRepository } from '@/domain/tokens/token.repository';
import { ITokenRepository } from '@/domain/tokens/token.repository.interface';
import { TokenType } from '@/domain/tokens/entities/token.entity';
import { DataDecodedParameter } from '@/routes/data-decode/entities/data-decoded-parameter.entity';
import { DataDecoded } from '@/routes/data-decode/entities/data-decoded.entity';
import { SettingsChangeTransaction } from '@/routes/transactions/entities/settings-change-transaction.entity';
import { TransactionInfo } from '@/routes/transactions/entities/transaction-info.entity';
import { CustomTransactionMapper } from '@/routes/transactions/mappers/common/custom-transaction.mapper';
import { DataDecodedParamHelper } from '@/routes/transactions/mappers/common/data-decoded-param.helper';
import { Erc20TransferMapper } from '@/routes/transactions/mappers/common/erc20-transfer.mapper';
import { Erc721TransferMapper } from '@/routes/transactions/mappers/common/erc721-transfer.mapper';
import { HumanDescriptionMapper } from '@/routes/transactions/mappers/common/human-description.mapper';
import { NativeCoinTransferMapper } from '@/routes/transactions/mappers/common/native-coin-transfer.mapper';
import { SettingsChangeMapper } from '@/routes/transactions/mappers/common/settings-change.mapper';
import { SwapOrderMapper } from '@/routes/transactions/mappers/common/swap-order.mapper';
import { ILoggingService, LoggingService } from '@/logging/logging.interface';
import { SwapOrderTransactionInfo } from '@/routes/transactions/entities/swaps/swap-order-info.entity';
import { SwapOrderHelper } from '@/routes/transactions/helpers/swap-order.helper';
import { TwapOrderMapper } from '@/routes/transactions/mappers/common/twap-order.mapper';
import { TwapOrderHelper } from '@/routes/transactions/helpers/twap-order.helper';
import { TwapOrderTransactionInfo } from '@/routes/transactions/entities/swaps/twap-order-info.entity';
import { NativeStakingDepositTransactionInfo } from '@/routes/transactions/entities/staking/native-staking-info.entity';
import { NativeStakingMapper } from '@/routes/transactions/mappers/common/native-staking.mapper';
import { KilnNativeStakingHelper } from '@/routes/transactions/helpers/kiln-native-staking.helper';

@Injectable()
export class MultisigTransactionInfoMapper {
  private readonly TRANSFER_METHOD = 'transfer';
  private readonly TRANSFER_FROM_METHOD = 'transferFrom';
  private readonly SAFE_TRANSFER_FROM_METHOD = 'safeTransferFrom';
  private readonly isRichFragmentsEnabled: boolean;
  private readonly isSwapsDecodingEnabled: boolean;
  private readonly isTwapsDecodingEnabled: boolean;
  private readonly isNativeStakingDecodingEnabled: boolean;

  private readonly ERC20_TRANSFER_METHODS = [
    this.TRANSFER_METHOD,
    this.TRANSFER_FROM_METHOD,
  ];

  private readonly ERC721_TRANSFER_METHODS = [
    this.TRANSFER_METHOD,
    this.TRANSFER_FROM_METHOD,
    this.SAFE_TRANSFER_FROM_METHOD,
  ];

  constructor(
    @Inject(ITokenRepository) private readonly tokenRepository: TokenRepository,
    @Inject(IConfigurationService)
    private readonly configurationService: IConfigurationService,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
    private readonly dataDecodedParamHelper: DataDecodedParamHelper,
    private readonly customTransactionMapper: CustomTransactionMapper,
    private readonly settingsChangeMapper: SettingsChangeMapper,
    private readonly nativeCoinTransferMapper: NativeCoinTransferMapper,
    private readonly erc20TransferMapper: Erc20TransferMapper,
    private readonly erc721TransferMapper: Erc721TransferMapper,
    private readonly humanDescriptionMapper: HumanDescriptionMapper,
    private readonly swapOrderMapper: SwapOrderMapper,
    private readonly swapOrderHelper: SwapOrderHelper,
    private readonly twapOrderMapper: TwapOrderMapper,
    private readonly twapOrderHelper: TwapOrderHelper,
    private readonly kilnNativeStakingHelper: KilnNativeStakingHelper,
    private readonly nativeStakingMapper: NativeStakingMapper,
  ) {
    this.isRichFragmentsEnabled = this.configurationService.getOrThrow(
      'features.richFragments',
    );
    this.isSwapsDecodingEnabled = this.configurationService.getOrThrow(
      'features.swapsDecoding',
    );
    this.isTwapsDecodingEnabled = this.configurationService.getOrThrow(
      'features.twapsDecoding',
    );
    this.isNativeStakingDecodingEnabled = this.configurationService.getOrThrow(
      'features.nativeStakingDecoding',
    );
  }

  async mapTransactionInfo(
    chainId: string,
    transaction: MultisigTransaction | ModuleTransaction,
  ): Promise<TransactionInfo> {
    const value = Number(transaction?.value) || 0;
    const dataByteLength = transaction.data
      ? Buffer.byteLength(transaction.data)
      : 0;

    const dataSize =
      dataByteLength >= 2 ? Math.floor((dataByteLength - 2) / 2) : 0;

    const richDecodedInfo =
      await this.humanDescriptionMapper.mapRichDecodedInfo(
        transaction,
        chainId,
      );

    const humanDescription =
      this.humanDescriptionMapper.mapHumanDescription(richDecodedInfo);

    // If the rich fragment feature is disabled, we set it as undefined.
    // Undefined properties are not rendered on the response
    const richDecodedInfoApiProperty = this.isRichFragmentsEnabled
      ? richDecodedInfo
      : undefined;

    if (this.isSwapsDecodingEnabled) {
      const swapOrder: SwapOrderTransactionInfo | null =
        await this.mapSwapOrder(chainId, transaction);
      // If the transaction is a swap order, we return it immediately
      if (swapOrder) return swapOrder;
    }

    if (this.isTwapsDecodingEnabled) {
      // If the transaction is a TWAP order, we return it immediately
      const twapOrder = await this.mapTwapOrder(chainId, transaction);
      if (twapOrder) {
        return twapOrder;
      }
    }

    if (this.isNativeStakingDecodingEnabled) {
      const nativeStakingDeposit = await this.mapNativeStakingDeposit(
        chainId,
        transaction,
      );
      // If the transaction is a native staking deposit, we return it immediately
      if (nativeStakingDeposit) {
        return nativeStakingDeposit;
      }
    }

    if (this.isCustomTransaction(value, dataSize, transaction.operation)) {
      return await this.customTransactionMapper.mapCustomTransaction(
        transaction,
        dataSize,
        chainId,
        humanDescription,
        richDecodedInfoApiProperty,
      );
    }

    if (this.isNativeCoinTransfer(value, dataSize)) {
      return this.nativeCoinTransferMapper.mapNativeCoinTransfer(
        chainId,
        transaction,
        humanDescription,
        richDecodedInfoApiProperty,
      );
    }

    if (this.isSettingsChange(transaction, value, dataSize)) {
      const settingsInfo = await this.settingsChangeMapper.mapSettingsChange(
        chainId,
        transaction,
      );

      if (!transaction.dataDecoded) {
        throw new Error(
          `Data decoded is null. txHash=${transaction.transactionHash}`,
        );
      }

      const dataDecodedParameters: DataDecodedParameter[] | null =
        transaction.dataDecoded.parameters?.map(
          (parameter) =>
            new DataDecodedParameter(
              parameter.name,
              parameter.type,
              parameter.value,
              parameter.valueDecoded,
            ),
        ) ?? null;

      return new SettingsChangeTransaction(
        new DataDecoded(transaction.dataDecoded.method, dataDecodedParameters),
        settingsInfo,
        humanDescription,
        richDecodedInfoApiProperty,
      );
    }

    if (this.isValidTokenTransfer(transaction)) {
      const token = await this.tokenRepository
        .getToken({ chainId, address: transaction.to })
        .catch(() => null);

      switch (token?.type) {
        case TokenType.Erc20:
          return this.erc20TransferMapper.mapErc20Transfer(
            token,
            chainId,
            transaction,
            humanDescription,
            richDecodedInfoApiProperty,
          );
        case TokenType.Erc721:
          return this.erc721TransferMapper.mapErc721Transfer(
            token,
            chainId,
            transaction,
            humanDescription,
            richDecodedInfoApiProperty,
          );
      }
    }

    return this.customTransactionMapper.mapCustomTransaction(
      transaction,
      dataSize,
      chainId,
      humanDescription,
      richDecodedInfoApiProperty,
    );
  }

  /**
   * Maps a swap order transaction.
   * If the transaction is not a swap order, it returns null.
   *
   * @param chainId
   * @param transaction
   * @private
   */
  private async mapSwapOrder(
    chainId: string,
    transaction: MultisigTransaction | ModuleTransaction,
  ): Promise<SwapOrderTransactionInfo | null> {
    if (!transaction?.data) {
      return null;
    }

    const orderData: `0x${string}` | null = this.swapOrderHelper.findSwapOrder(
      transaction.data,
    );

    if (!orderData) {
      return null;
    }

    try {
      return await this.swapOrderMapper.mapSwapOrder(chainId, {
        data: orderData,
      });
    } catch (error) {
      // The transaction is a swap order, but we couldn't decode it successfully.
      this.loggingService.warn(error);
      return null;
    }
  }

  /**
   * Maps a TWAP order transaction.
   * If the transaction is not a TWAP order, it returns null.
   *
   * @param chainId - chain ID of the transaction
   * @param transaction - transaction to map
   * @returns mapped {@link TwapOrderTransactionInfo} or null if none found
   */
  private async mapTwapOrder(
    chainId: string,
    transaction: MultisigTransaction | ModuleTransaction,
  ): Promise<TwapOrderTransactionInfo | null> {
    if (!transaction?.data) {
      return null;
    }

    const orderData = this.twapOrderHelper.findTwapOrder({
      to: transaction.to,
      data: transaction.data,
    });

    if (!orderData) {
      return null;
    }

    try {
      return await this.twapOrderMapper.mapTwapOrder(
        chainId,
        transaction.safe,
        {
          data: orderData,
          executionDate: transaction.executionDate,
        },
      );
    } catch (error) {
      this.loggingService.warn(error);
      return null;
    }
  }

  /**
   * Maps a native staking `deposit` transaction.
   * If the transaction is not to an official deployment, it returns null.
   *
   * @param chainId - chain ID of the transaction
   * @param transaction - transaction to map
   * @returns mapped {@link NativeStakingDepositTransactionInfo} or null if none found
   */
  private async mapNativeStakingDeposit(
    chainId: string,
    transaction: MultisigTransaction | ModuleTransaction,
  ): Promise<NativeStakingDepositTransactionInfo | null> {
    if (!transaction?.data) {
      return null;
    }

    const nativeStakingTransaction =
      await this.kilnNativeStakingHelper.findDeposit({
        chainId,
        to: transaction.to,
        data: transaction.data,
      });

    if (!nativeStakingTransaction) {
      return null;
    }

    try {
      const tx = transaction as MultisigTransaction;
      const isConfirmed =
        !!tx.confirmations &&
        tx.confirmations.length >= tx.confirmationsRequired;

      return await this.nativeStakingMapper.mapDepositInfo({
        chainId,
        to: nativeStakingTransaction.to,
        isConfirmed,
        depositExecutionDate: transaction.executionDate,
      });
    } catch (error) {
      this.loggingService.warn(error);
      return null;
    }
  }

  private isCustomTransaction(
    value: number,
    dataSize: number,
    operation: Operation,
  ): boolean {
    return (value > 0 && dataSize > 0) || operation !== Operation.CALL;
  }

  private isNativeCoinTransfer(value: number, dataSize: number): boolean {
    return value > 0 && dataSize === 0;
  }

  private isSettingsChange(
    transaction: MultisigTransaction | ModuleTransaction,
    value: number,
    dataSize: number,
  ): boolean {
    const isSettingsChangeMethod: boolean = transaction.dataDecoded
      ? SettingsChangeMapper.SETTINGS_CHANGE_METHODS.includes(
          transaction.dataDecoded.method,
        )
      : false;

    return (
      value === 0 &&
      dataSize > 0 &&
      transaction.safe === transaction.to &&
      isSettingsChangeMethod
    );
  }

  private isValidTokenTransfer(
    transaction: MultisigTransaction | ModuleTransaction,
  ): boolean {
    return (
      (this.isErc20Transfer(transaction) ||
        this.isErc721Transfer(transaction)) &&
      this.isSafeSenderOrReceiver(transaction)
    );
  }

  private isErc20Transfer(
    transaction: MultisigTransaction | ModuleTransaction,
  ): boolean {
    const { dataDecoded } = transaction;
    return this.ERC20_TRANSFER_METHODS.some(
      (method) => method === dataDecoded?.method,
    );
  }

  private isErc721Transfer(
    transaction: MultisigTransaction | ModuleTransaction,
  ): boolean {
    const { dataDecoded } = transaction;
    return this.ERC721_TRANSFER_METHODS.some(
      (method) => method === dataDecoded?.method,
    );
  }

  private isSafeSenderOrReceiver(
    transaction: MultisigTransaction | ModuleTransaction,
  ): boolean {
    const { dataDecoded } = transaction;
    if (!dataDecoded) return false;
    return (
      this.TRANSFER_METHOD == dataDecoded.method ||
      this.dataDecodedParamHelper.getFromParam(dataDecoded, '') ===
        transaction.safe ||
      this.dataDecodedParamHelper.getToParam(dataDecoded, '') ===
        transaction.safe
    );
  }
}
