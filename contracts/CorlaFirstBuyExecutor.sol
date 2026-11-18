// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ICorlaFirstBuyMint {
    function factory() external view returns (address);
    function creator() external view returns (address);
    function expectedToken() external view returns (address);
    function token() external view returns (address);
    function pool() external view returns (address);
    function quoteToken() external view returns (address);
    function launched() external view returns (bool);
    function emergencyWithdrawn() external view returns (bool);
    function getMintState() external view returns (uint256, uint8);
    function totalLots() external view returns (uint256);
    function mintedLots() external view returns (uint256);
    function fundingDeadline() external view returns (uint64);
    function agentOnly() external view returns (bool);
    function whitelistEnabled() external view returns (bool);
    function whitelistDeadline() external view returns (uint64);
}

interface ICorlaFirstBuyRegistry {
    function deploymentIndexPlusOne(address) external view returns (uint256);
    function deployment(uint256) external view returns (address, address, address);
}

interface ICorlaFirstBuyBeacon { function implementation() external view returns (address); }
interface ICorlaFirstBuyFactory { function getPair(address, address) external view returns (address); }
interface ICorlaFirstBuyPair {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}
interface ICorlaFirstBuyToken {
    function mainPool() external view returns (address);
    function buyTaxRate() external view returns (uint16);
    function sellTaxRate() external view returns (uint16);
    function balanceOf(address) external view returns (uint256);
}
interface ICorlaFirstBuyRouter {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256, address[] calldata, address, uint256
    ) external payable;
}

/// @notice Owner-preconfigured native-BNB first-buy-only executor for the pinned
/// Corla v4 / Pancake V2 deployment. It is not a general-purpose trading router.
/// @dev Off-chain code must obtain an initial-reserve anchor from a checked
/// hypothetical-launch simulation. evidenceHash identifies that evidence; it is
/// NOT an on-chain proof. This contract checks equality with the configured
/// anchor; it cannot independently prove that a caller-supplied anchor describes
/// original liquidity rather than a later state. Production callers MUST use
/// the checked preparation flow and must not expose editable reserve anchors.
/// Reverted inner calls are caught so the outer attempt counter persists.
/// Consequently status=1 on an execute receipt is NOT evidence of a purchase:
/// consumers must verify Filled and the canonical receipt.
contract CorlaFirstBuyExecutor {
    address public constant CORLA_FACTORY = 0xfBA753F8B890eB35caA000c427f99ed5903eA517;
    address public constant CORLA_BEACON = 0xdf8D1028FAbdA0201dBaF577A660fD8223d5b160;
    address public constant CORLA_IMPLEMENTATION = 0x9a2E15A581CE87F5D586745dA78b9AeB01633583;
    address public constant PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address public constant ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    bytes32 public constant MINT_PROXY_HASH = 0xf2a797a10ac6f455a43f13be5d1ff68a386ce8a2617010db99189fb8bfc985ec;
    bytes32 public constant BEACON_HASH = 0x57bd57aa687d9f05ea198be550c316d6fd8e5d8146145d8c34b2a75dd557f416;
    bytes32 public constant IMPLEMENTATION_HASH = 0x14a2b6569fbf22f98704500d13da0142ebe67017c1b42b42b5bbba37abb647f8;
    bytes32 public constant FACTORY_PROXY_HASH = 0x18d9741e68a6903b5a967719313e2bee1308277ead710e1674562152c2e49dfa;
    uint16 public constant MAX_ATTEMPTS = 1024;
    uint256 public constant OUTER_GAS_BUFFER = 120_000;

    enum State { None, Armed, Filled, Cancelled, Exhausted }
    struct ArmParams {
        address mint;
        address token;
        uint128 amountIn;
        uint128 expectedReserveBnb;
        uint128 expectedReserveToken;
        uint128 minOut;
        uint64 validUntilBlock;
        uint64 deadline;
        uint64 maxGasPriceWei;
        uint32 maxBuyGas;
        uint16 maxAttempts;
        uint16 maxBuyTaxBps;
        uint16 maxSellTaxBps;
        uint16 maxOpeningPremiumBps;
        bytes32 evidenceHash;
    }

    address public immutable owner;
    mapping(address => bool) public operators;
    mapping(address => bool) public spentMint;
    mapping(address => bool) public spentToken;
    uint256 public sequence;
    bytes32 private _intentId;
    ArmParams private _params;
    State private _state;
    uint16 private _attempts;
    uint256 private _entered;

    error Unauthorized();
    error Reentrant();
    error InvalidConfiguration();
    error UnsupportedProtocol();
    error WrongIntent();
    error NotArmed();
    error Expired();
    error GasPriceTooHigh();
    error InsufficientOuterGas();
    error NotLaunched();
    error PoolChanged();
    error TaxLimit();
    error InsufficientOutput();
    error TransferFailed();

    event OperatorChanged(address indexed operator, bool enabled);
    event IntentArmed(bytes32 indexed intentId, address indexed mint, address indexed token);
    event IntentCancelled(bytes32 indexed intentId);
    event AttemptResult(bytes32 indexed intentId, uint16 attempt, bool bought, uint256 amountOut, bytes32 reasonHash);
    event Filled(bytes32 indexed intentId, address indexed mint, address indexed token, address recipient, uint256 amountIn, uint256 amountOut);
    event NativeWithdrawn(uint256 amount);

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier nonReentrant() {
        if (_entered != 0) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address owner_, address[] memory operators_) {
        if (block.chainid != 56 || owner_ == address(0) || operators_.length > 32) revert InvalidConfiguration();
        owner = owner_;
        operators[owner_] = true;
        for (uint256 i; i < operators_.length; ++i) {
            if (operators_[i] == address(0) || operators_[i] == address(this)) revert InvalidConfiguration();
            operators[operators_[i]] = true;
        }
    }

    receive() external payable {}

    function readArm() external view returns (bytes32 intentId, ArmParams memory params, uint8 state, uint16 attempts) {
        return (_intentId, _params, uint8(_state), _attempts);
    }

    function setOperator(address operator, bool enabled) external onlyOwner nonReentrant {
        if (operator == address(0) || operator == address(this)) revert InvalidConfiguration();
        operators[operator] = enabled;
        emit OperatorChanged(operator, enabled);
    }

    function arm(ArmParams calldata p) external payable onlyOwner nonReentrant returns (bytes32 intentId) {
        if (_state == State.Armed || p.mint == address(0) || p.token == address(0) || p.mint == p.token ||
            p.token == WBNB || spentMint[p.mint] || spentToken[p.token] || p.amountIn == 0 || p.minOut == 0 ||
            p.expectedReserveBnb == 0 || p.expectedReserveToken == 0 ||
            p.expectedReserveBnb > type(uint112).max || p.expectedReserveToken > type(uint112).max ||
            p.minOut >= p.expectedReserveToken || uint256(p.amountIn) * 10 > p.expectedReserveBnb ||
            p.maxAttempts == 0 || p.maxAttempts > MAX_ATTEMPTS || p.maxBuyTaxBps > 1000 ||
            p.maxSellTaxBps > 1000 || p.maxOpeningPremiumBps > 1000 || p.evidenceHash == bytes32(0) ||
            p.maxGasPriceWei == 0 || p.maxGasPriceWei > 100 gwei || p.maxBuyGas < 150_000 || p.maxBuyGas > 1_500_000 ||
            p.validUntilBlock <= block.number || uint256(p.validUntilBlock) > block.number + 4096 ||
            p.deadline <= block.timestamp || uint256(p.deadline) > block.timestamp + 3600 ||
            address(this).balance < p.amountIn) revert InvalidConfiguration();
        _verifyProtocol(p.mint, p.token);
        ICorlaFirstBuyMint mint = ICorlaFirstBuyMint(p.mint);
        (, uint8 phase) = mint.getMintState();
        uint256 total = mint.totalLots();
        if (phase != 1 || mint.launched() || mint.emergencyWithdrawn() || mint.token() != address(0) ||
            mint.pool() != address(0) || p.token.code.length != 0 || total == 0 || mint.mintedLots() >= total ||
            p.deadline > mint.fundingDeadline()) revert InvalidConfiguration();
        sequence += 1;
        _params = p;
        _attempts = 0;
        _state = State.Armed;
        intentId = keccak256(abi.encode(block.chainid, address(this), owner, sequence, p));
        _intentId = intentId;
        emit IntentArmed(intentId, p.mint, p.token);
    }

    /// @notice A failed inner buy returns false but consumes one global attempt.
    /// Callers pay their own gas. There is no gas reimbursement or public route
    /// fallback; a receipt with no Filled event must never be treated as a buy.
    function execute(bytes32 intentId) external nonReentrant returns (bool bought) {
        if (!operators[msg.sender]) revert Unauthorized();
        if (intentId != _intentId) revert WrongIntent();
        if (_state != State.Armed || _attempts >= _params.maxAttempts) revert NotArmed();
        if (block.number > _params.validUntilBlock || block.timestamp > _params.deadline) revert Expired();
        if (tx.gasprice > _params.maxGasPriceWei) revert GasPriceTooHigh();
        if (gasleft() < uint256(_params.maxBuyGas) + OUTER_GAS_BUFFER) revert InsufficientOuterGas();
        _attempts += 1;
        bytes memory payload = abi.encodeCall(this.performBuy, (intentId));
        uint256 maxBuyGas = _params.maxBuyGas;
        uint256 amountOut;
        bytes32 reasonHash;
        bool success;
        // Return data from a newly launched token is not trusted. Copy at most
        // 256 failure bytes so a returndata bomb cannot erase the attempt count.
        assembly ("memory-safe") {
            let out := mload(0x40)
            success := call(maxBuyGas, address(), 0, add(payload, 32), mload(payload), out, 32)
            if success {
                if iszero(eq(returndatasize(), 32)) { success := 0 }
                amountOut := mload(out)
            }
            if iszero(success) {
                let size := returndatasize()
                if gt(size, 256) { size := 256 }
                returndatacopy(out, 0, size)
                reasonHash := keccak256(out, size)
            }
            mstore(0x40, add(out, 256))
        }
        if (success) {
            _state = State.Filled;
            emit Filled(intentId, _params.mint, _params.token, owner, _params.amountIn, amountOut);
            emit AttemptResult(intentId, _attempts, true, amountOut, bytes32(0));
            return true;
        } else {
            if (_attempts == _params.maxAttempts) _state = State.Exhausted;
            emit AttemptResult(intentId, _attempts, false, 0, reasonHash);
            return false;
        }
    }

    /// @dev Only reachable from execute's bounded self-call. Any revert rolls
    /// back both principal spending and the successful-once locks in this frame.
    function performBuy(bytes32 intentId) external returns (uint256 amountOut) {
        if (msg.sender != address(this) || _entered != 1) revert Unauthorized();
        if (_state != State.Armed || intentId != _intentId) revert WrongIntent();
        ArmParams memory p = _params;
        if (spentMint[p.mint] || spentToken[p.token]) revert NotArmed();
        _verifyProtocol(p.mint, p.token);
        ICorlaFirstBuyMint mint = ICorlaFirstBuyMint(p.mint);
        (, uint8 phase) = mint.getMintState();
        if (!mint.launched() || mint.emergencyWithdrawn() || phase != 3 || mint.token() != p.token ||
            mint.mintedLots() != mint.totalLots() || p.token.code.length == 0) revert NotLaunched();
        address pool = mint.pool();
        if (pool == address(0) || ICorlaFirstBuyFactory(PANCAKE_FACTORY).getPair(WBNB, p.token) != pool ||
            ICorlaFirstBuyPair(pool).factory() != PANCAKE_FACTORY || ICorlaFirstBuyToken(p.token).mainPool() != pool) revert PoolChanged();
        address token0 = ICorlaFirstBuyPair(pool).token0();
        address token1 = ICorlaFirstBuyPair(pool).token1();
        bool quoteFirst = token0 == WBNB;
        if (quoteFirst ? token1 != p.token : token0 != p.token || token1 != WBNB) revert PoolChanged();
        (uint112 reserve0, uint112 reserve1,) = ICorlaFirstBuyPair(pool).getReserves();
        if ((quoteFirst ? reserve0 : reserve1) != p.expectedReserveBnb ||
            (quoteFirst ? reserve1 : reserve0) != p.expectedReserveToken) revert PoolChanged();
        uint256 buyTax = ICorlaFirstBuyToken(p.token).buyTaxRate();
        if (buyTax > p.maxBuyTaxBps || ICorlaFirstBuyToken(p.token).sellTaxRate() > p.maxSellTaxBps) revert TaxLimit();
        uint256 feeIn = uint256(p.amountIn) * 9975;
        uint256 gross = feeIn * p.expectedReserveToken / (uint256(p.expectedReserveBnb) * 10000 + feeIn);
        uint256 net = gross * (10000 - buyTax) / 10000;
        uint256 denominator = 10000 + p.maxOpeningPremiumBps;
        uint256 minOut = (net * 10000 + denominator - 1) / denominator;
        if (p.minOut > minOut) minOut = p.minOut;
        if (minOut == 0 || address(this).balance < p.amountIn) revert InsufficientOutput();
        uint256 beforeBalance = ICorlaFirstBuyToken(p.token).balanceOf(owner);
        spentMint[p.mint] = true;
        spentToken[p.token] = true;
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = p.token;
        ICorlaFirstBuyRouter(ROUTER).swapExactETHForTokensSupportingFeeOnTransferTokens{value: p.amountIn}(
            minOut, path, owner, p.deadline
        );
        uint256 afterBalance = ICorlaFirstBuyToken(p.token).balanceOf(owner);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance < minOut) revert InsufficientOutput();
        return afterBalance - beforeBalance;
    }

    function cancel(bytes32 intentId) external onlyOwner nonReentrant {
        if (intentId != _intentId) revert WrongIntent();
        if (_state != State.Armed) revert NotArmed();
        _state = State.Cancelled;
        emit IntentCancelled(intentId);
    }

    function withdrawNative(uint256 amount) external onlyOwner nonReentrant {
        uint256 reserved = _state == State.Armed ? _params.amountIn : 0;
        if (amount > address(this).balance || address(this).balance - amount < reserved) revert InvalidConfiguration();
        (bool success,) = payable(owner).call{value: amount}("");
        if (!success) revert TransferFailed();
        emit NativeWithdrawn(amount);
    }

    function _verifyProtocol(address mint, address token) internal view virtual {
        if (block.chainid != 56 || mint.codehash != MINT_PROXY_HASH ||
            CORLA_BEACON.codehash != BEACON_HASH || CORLA_IMPLEMENTATION.codehash != IMPLEMENTATION_HASH ||
            CORLA_FACTORY.codehash != FACTORY_PROXY_HASH ||
            ICorlaFirstBuyBeacon(CORLA_BEACON).implementation() != CORLA_IMPLEMENTATION) revert UnsupportedProtocol();
        uint256 index = ICorlaFirstBuyRegistry(CORLA_FACTORY).deploymentIndexPlusOne(mint);
        if (index == 0) revert UnsupportedProtocol();
        (address registeredMint, address registeredCreator, address registeredToken) = ICorlaFirstBuyRegistry(CORLA_FACTORY).deployment(index - 1);
        if (registeredMint != mint || registeredToken != token ||
            registeredCreator != ICorlaFirstBuyMint(mint).creator() ||
            ICorlaFirstBuyMint(mint).factory() != CORLA_FACTORY ||
            ICorlaFirstBuyMint(mint).expectedToken() != token ||
            ICorlaFirstBuyMint(mint).quoteToken() != address(0)) revert UnsupportedProtocol();
    }
}
