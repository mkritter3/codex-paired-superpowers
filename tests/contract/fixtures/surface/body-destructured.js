const subcommands = {
  alpha(args) {
    const { newFlag, renamed: localName } = args;
    return [newFlag, localName];
  },
};
