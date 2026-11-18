// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "../../contracts/CorlaFirstBuyExecutor.sol";

// Local-EVM fixtures only: never deploy these contracts or use their bypassed
// protocol identity check as a production executor.
contract FirstBuyHarness is CorlaFirstBuyExecutor {
    constructor(address owner_, address[] memory operators_) CorlaFirstBuyExecutor(owner_, operators_) {}
    function _verifyProtocol(address, address) internal pure override {}
}

contract FirstBuyMockMint {
    address public constant factory = 0xfBA753F8B890eB35caA000c427f99ed5903eA517;
    address public creator;
    address public expectedToken;
    address public token;
    address public pool;
    address public quoteToken;
    bool public launched;
    bool public emergencyWithdrawn;
    bool public agentOnly;
    bool public whitelistEnabled;
    uint64 public whitelistDeadline;
    uint64 public fundingDeadline = type(uint64).max;
    uint256 public totalLots = 50;
    uint256 public mintedLots = 49;
    uint8 public phase = 1;
    constructor(address target) { expectedToken = target; creator = msg.sender; }
    function getMintState() external view returns (uint256, uint8) { return (mintedLots, phase); }
    function launch(address pair) external { token = expectedToken; pool = pair; launched = true; mintedLots = totalLots; phase = 3; }
    function setQuote(address value) external { quoteToken = value; }
}

contract FirstBuyMockPair {
    address public constant factory = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;
    constructor(address a, address b) { (token0, token1) = a < b ? (a, b) : (b, a); }
    function setReserves(uint112 quote, uint112 target) external {
        bool quoteFirst = token0 == 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
        (reserve0, reserve1) = quoteFirst ? (quote, target) : (target, quote);
    }
    function getReserves() external view returns (uint112, uint112, uint32) { return (reserve0, reserve1, 1); }
}

contract FirstBuyMockFactory {
    address public pair;
    function setPair(address p) external { pair = p; }
    function getPair(address, address) external view returns (address) { return pair; }
}

contract FirstBuyMockToken {
    address public mainPool;
    uint16 public buyTaxRate;
    uint16 public sellTaxRate;
    mapping(address => uint256) public balanceOf;
    function configure(address p, uint16 buyTax, uint16 sellTax) external {
        mainPool = p; buyTaxRate = buyTax; sellTaxRate = sellTax;
    }
    function mint(address recipient, uint256 amount) external { balanceOf[recipient] += amount; }
}

contract FirstBuyMockRouter {
    address public target;
    uint256 public payout;
    bool public fail;
    bool public reenter;
    bool public bomb;
    address public executor;
    bytes32 public intent;
    function configure(address token, uint256 output, bool fails) external { target = token; payout = output; fail = fails; }
    function configureReentry(address e, bytes32 id) external { executor = e; intent = id; reenter = true; }
    function configureBomb() external { bomb = true; }
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 minimum, address[] calldata path, address to, uint256) external payable {
        if (bomb) { assembly { revert(0, 32768) } }
        require(!fail && path.length == 2 && path[1] == target, "mock route");
        if (reenter) {
            (bool success,) = executor.call(abi.encodeCall(CorlaFirstBuyExecutor.execute, (intent)));
            require(!success, "reentry unexpectedly succeeded");
        }
        // Do not implement the Router's own minOut check: the executor must
        // independently reject insufficient balance delta and roll back spend.
        minimum;
        FirstBuyMockToken(target).mint(to, payout);
    }
}
