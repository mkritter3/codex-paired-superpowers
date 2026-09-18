const subcommands = {
  alpha(args) {
    const forwarded = { ...args };
    return consume(forwarded);
  },
};
