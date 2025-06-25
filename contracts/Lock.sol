// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Uncomment this line to use console.log
// import "hardhat/console.sol";

contract Lock {
    // Removed unlockTime variable as it's no longer needed
    address payable public owner;
    
    // Mapping to track balances of individual depositors
    mapping(address => uint) public balances;
    // Mapping to track the timestamp when each depositor can withdraw their funds
    mapping(address => uint) public withdrawalAllowedAfter;
    
    // Total balance deposited by the owner during initialization
    uint public ownerInitialBalance;

    event Withdrawal(uint amount, uint when, address indexed withdrawer);
    event Deposit(uint amount, address indexed depositor, uint withdrawalAllowedAfter);

    constructor() payable {
        owner = payable(msg.sender);
        ownerInitialBalance = msg.value;
        balances[msg.sender] = msg.value;
        withdrawalAllowedAfter[msg.sender] = block.timestamp + 1 days;
    }

    // Function for anyone to deposit funds
    function deposit() public payable {
        require(msg.value > 0, "Deposit amount must be greater than 0");
        balances[msg.sender] += msg.value;
        // Set withdrawal time to 24 hours from now
        uint withdrawalTime = block.timestamp + 1 days;
        // If this is not the first deposit, keep the latest withdrawal time
        if (withdrawalAllowedAfter[msg.sender] == 0 || withdrawalTime > withdrawalAllowedAfter[msg.sender]) {
            withdrawalAllowedAfter[msg.sender] = withdrawalTime;
        }
        emit Deposit(msg.value, msg.sender, withdrawalAllowedAfter[msg.sender]);
    }

    // Function for withdrawing funds
    function withdraw() public {
        uint balance = balances[msg.sender];
        require(balance > 0, "No funds to withdraw");
        require(block.timestamp >= withdrawalAllowedAfter[msg.sender], "You can't withdraw yet");
        
        balances[msg.sender] = 0;
        withdrawalAllowedAfter[msg.sender] = 0; // Reset withdrawal time
        emit Withdrawal(balance, block.timestamp, msg.sender);
        payable(msg.sender).transfer(balance);
    }

    // Function to get the balance of any address
    function getBalance(address _address) public view returns (uint) {
        return balances[_address];
    }
}
