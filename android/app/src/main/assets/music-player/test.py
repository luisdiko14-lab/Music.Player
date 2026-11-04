import sys
import time

def main():
    print("========================================")
    print("      NUMBER PRINTER SPEED SELECTOR     ")
    print("========================================")
    print("Select how fast you want the numbers to go:")
    print("  1. Turbo (Blazing fast - 0.001s delay)")
    print("  2. Fast   (Quick scroll - 0.01s delay)")
    print("  3. Normal (Readable pace - 0.05s delay)")
    print("  4. Slow   (Relaxed pace - 0.2s delay)")
    print("  5. Custom (Enter your own delay)")
    
    choice = input("\nEnter your choice (1-5): ").strip()
    
    # Set delay based on user choice
    if choice == '1':
        delay = 0.001
    elif choice == '2':
        delay = 0.01
    elif choice == '3':
        delay = 0.05
    elif choice == '4':
        delay = 0.2
    elif choice == '5':
        try:
            delay = float(input("Enter delay in seconds (e.g., 0.1): "))
        except ValueError:
            print("Invalid input! Defaulting to Normal speed (0.05s).")
            delay = 0.05
    else:
        print("Invalid choice! Defaulting to Normal speed (0.05s).")
        delay = 0.05

    print(f"\nStarting sequence from 10 to 1000000 (Delay: {delay}s)...\n")
    time.sleep(1) # Brief pause before starting
    
    # Loop from 10 to 1000000
    for i in range(10, 1000001):
        print(i, flush=True)
        time.sleep(delay)
        
    print("\n🎉 Finished printing 10 to 1000000!")

if __name__ == "__main__":
    main()