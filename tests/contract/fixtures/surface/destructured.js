const subcommands = {
  alpha({ required, renamed: localName = 'default' }) {
    process.stdout.write(JSON.stringify({ required, localName }));
  },
};
